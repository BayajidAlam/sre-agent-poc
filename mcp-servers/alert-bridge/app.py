"""alert-bridge — converts Alertmanager webhooks to A2A calls on rca-agent.

Alertmanager posts a webhook whenever a payload to a receiver. This bridge
takes that webhook, extracts the alert context, then:

  1. Asks trace-agent (A2A) for a rich IncidentContext (traces/logs/metrics).
  2. Falls back to a minimal synthetic context if trace-agent is unreachable.
  3. Merges the alert metadata with the trace-agent context.
  4. Forwards the enriched context to rca-agent (A2A). The rca-agent then
     chains to remediator-agent via its tool config
     (see manifests/agents/rca-agent.yaml).
"""
import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("alert-bridge")

# Backwards-compat alias
async def call_rca_agent_a2a(incident_ctx: dict) -> dict:
    return await call_agent_a2a(RCA_AGENT_URL, incident_ctx, "rca-agent")

RCA_AGENT_URL = os.environ.get(
    "RCA_AGENT_URL",
    "http://rca-agent.agent-read.svc.cluster.local:8080/",
)
REMEDIATOR_AGENT_URL = os.environ.get(
    "REMEDIATOR_AGENT_URL",
    "http://remediator-agent.agent-read.svc.cluster.local:8080/",
)
TRACE_AGENT_URL = os.environ.get(
    "TRACE_AGENT_URL",
    "http://trace-agent.agent-read.svc.cluster.local:8080/",
)

app = FastAPI()


def alert_to_incident_context(alert: dict) -> dict:
    """Convert one Alertmanager alert to a minimal IncidentContext (used as the
    seed for trace-agent and as a fallback if trace-agent is unavailable).
    """
    labels = alert.get("labels", {}) or {}
    annotations = alert.get("annotations", {}) or {}
    now = datetime.now(timezone.utc).isoformat()
    started = alert.get("startsAt") or now
    return {
        "incident_id": alert.get("fingerprint") or f"alert-{uuid.uuid4().hex[:8]}",
        "service": labels.get("service") or labels.get("app") or "unknown",
        "namespace": labels.get("namespace") or "apps-demo",
        "severity": labels.get("severity") or "warning",
        "window_start": started,
        "window_end": now,
        "alert_name": labels.get("alertname") or "UnknownAlert",
        "summary": annotations.get("summary") or alert.get("summary") or labels.get("alertname"),
        "description": annotations.get("description") or alert.get("description") or "",
        "started_at": started,
        "evidence": [
            {"source": "alertmanager", "msg": annotations.get("summary") or labels.get("alertname", "")},
        ],
        "traces": [],
        "logs": [],
        "metrics": [],
    }


def extract_json_from_sse(body: str) -> str | None:
    """Return the last data: payload from a streamable-HTTP SSE response, or
    the raw body if it's not SSE-shaped (kagent returns plain JSON in some
    code paths)."""
    last = None
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload and payload != "[DONE]":
                last = payload
    if last is not None:
        return last
    stripped = body.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        return stripped
    return None


def _try_parse_json(text: str | None) -> dict | None:
    if not text:
        return None
    try:
        obj = json.loads(text)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def find_incident_context_in_event(event) -> dict | None:
    """Best-effort: kagent A2A SSE streams wrap the agent's reply inside a
    `result.parts[*].text` (or 'result.message.parts[*].text'). The agent itself
    returns a JSON object as its final reply text. Walk the event looking for
    the first text part that parses as a JSON dict containing the
    IncidentContext shape."""
    if not isinstance(event, dict):
        return None
    # Candidate containers for the agent reply text.
    candidates = []
    result = event.get("result")
    if isinstance(result, dict):
        candidates.append(result)
        msg = result.get("message") or result.get("statusMessage")
        if isinstance(msg, dict):
            candidates.append(msg)
        for part in result.get("parts") or []:
            if isinstance(part, dict) and "text" in part:
                candidates.append(part)
    # Walk each candidate and try to find an inner JSON dict.
    for c in candidates:
        if isinstance(c, dict) and isinstance(c.get("text"), str):
            parsed = _try_parse_json(c["text"])
            if parsed and {"incident_id", "service"} <= set(parsed.keys()):
                return parsed
        parsed = _try_parse_json(json.dumps(c))
        if parsed and {"incident_id", "service"} <= set(parsed.keys()):
            return parsed
    return None


async def enrich_via_trace_agent(seed_ctx: dict) -> dict:
    """Call trace-agent via A2A with the seed context. Return the enriched
    IncidentContext (or the seed with a `trace_agent_error` annotation on
    failure). Never raises — trace-agent is best-effort enrichment."""
    payload = {
        "jsonrpc": "2.0",
        "id": "1",
        "method": "message/send",
        "params": {
            "id": f"task-{uuid.uuid4().hex[:8]}",
            "message": {
                "messageId": f"msg-{uuid.uuid4().hex[:8]}",
                "role": "user",
                "parts": [{"type": "text", "text": json.dumps(seed_ctx)}],
            },
        },
    }
    timeout = httpx.Timeout(60.0, read=60.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(TRACE_AGENT_URL, json=payload)
            body = r.text
            log.info(
                "trace-agent response status=%d len=%d",
                r.status_code,
                len(body),
            )
    except Exception as e:
        log.warning("trace-agent unreachable, falling back to seed: %s", e)
        return {**seed_ctx, "trace_agent_error": f"transport_error: {e}"}

    last_event = extract_json_from_sse(body)
    event = _try_parse_json(last_event)
    if event is None:
        # Some A2A responses are plain JSON without SSE wrapping.
        event = _try_parse_json(body)
    enriched = find_incident_context_in_event(event) if event else None
    if enriched is None:
        log.warning("trace-agent reply did not contain a JSON IncidentContext")
        return {**seed_ctx, "trace_agent_error": "no_incident_context_in_reply"}

    # Merge: keep the alertmetadata, overlay trace-agent's traces/logs/metrics.
    merged = dict(seed_ctx)  # alertmetadata + window
    for key in ("traces", "logs", "metrics"):
        val = enriched.get(key)
        if isinstance(val, list):
            merged[key] = val
    # Carry forward trace-agent's window if it set one.
    for key in ("window_start", "window_end"):
        if key in enriched and enriched[key]:
            merged[key] = enriched[key]
    # Annotate provenance.
    evidence = list(merged.get("evidence") or [])
    evidence.append(
        {
            "source": "trace-agent",
            "msg": f"enriched with {len(enriched.get('traces', []))} traces, "
            f"{len(enriched.get('logs', []))} log lines, "
            f"{len(enriched.get('metrics', []))} metrics",
        }
    )
    merged["evidence"] = evidence
    log.info(
        "trace-agent enriched context: %d traces, %d logs, %d metrics",
        len(merged.get("traces", [])),
        len(merged.get("logs", [])),
        len(merged.get("metrics", [])),
    )
    return merged


async def call_agent_a2a(agent_url: str, incident_ctx: dict, agent_name: str) -> dict:
    """Post the incident context to an agent via A2A JSON-RPC and stream back the response."""
    payload = {
        "jsonrpc": "2.0",
        "id": "1",
        "method": "message/send",
        "params": {
            "id": f"task-{uuid.uuid4().hex[:8]}",
            "message": {
                "messageId": f"msg-{uuid.uuid4().hex[:8]}",
                "role": "user",
                "parts": [{"type": "text", "text": json.dumps(incident_ctx)}],
            },
        },
    }
    timeout = httpx.Timeout(300.0, read=300.0)
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(agent_url, json=payload)
        body = r.text
        log.info("%s response status=%d len=%d", agent_name, r.status_code, len(body))
        # Extract last JSON event from SSE response
        last_json = None
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                last_json = line[5:].strip()
        return {"http_status": r.status_code, "body": body[:20000], "last_event": last_json}


@app.get("/healthz")
def healthz():
    return {
        "status": "ok",
        "rca_agent": RCA_AGENT_URL,
        "remediator_agent": REMEDIATOR_AGENT_URL,
        "trace_agent": TRACE_AGENT_URL,
    }


@app.post("/alerts")
async def alerts(req: Request):
    """Alertmanager webhook entry point.

    For each alert, drive the full chain explicitly:
      trace-agent -> rca-agent -> remediator-agent.

    The orchestrator (this service) calls each agent in turn and forwards
    the previous agent's structured output as the next agent's input. This
    is more reliable than relying on agents to delegate to A2A peers (which
    Gemini doesn't always do without explicit nudging).
    """
    body = await req.json()
    log.info("received alertmanager payload: %s", json.dumps(body)[:500])
    alerts = body.get("alerts", []) if isinstance(body, dict) else []
    if not alerts:
        return JSONResponse({"status": "no_alerts"}, status_code=200)
    results = []
    for alert in alerts:
        seed = alert_to_incident_context(alert)
        log.info(
            "dispatching incident %s via trace-agent -> rca-agent -> remediator-agent",
            seed["incident_id"],
        )
        enriched = await enrich_via_trace_agent(seed)
        rca = await call_agent_a2a(RCA_AGENT_URL, enriched, "rca-agent")
        # Forward the RCA agent's reply (which contains the RCAFinding) to
        # remediator-agent so it can run policy + apply.
        rca_text = (rca.get("last_event") or rca.get("body") or "")
        if not rca_text:
            log.warning(
                "rca-agent reply empty for incident %s; skipping remediation",
                seed["incident_id"],
            )
            results.append(
                {
                    "incident_id": seed["incident_id"],
                    "rca_agent": rca,
                    "remediator_agent": {"http_status": 0, "skipped": True},
                }
            )
            continue
        rem = await call_agent_a2a(
            REMEDIATOR_AGENT_URL, rca_text, "remediator-agent"
        )
        results.append(
            {
                "incident_id": seed["incident_id"],
                "rca_agent": rca,
                "remediator_agent": rem,
            }
        )
    return JSONResponse({"status": "dispatched", "results": results}, status_code=200)


@app.post("/incident")
async def incident(req: Request):
    """Manual trigger — accepts an IncidentContext JSON directly, then drives
    the same trace-agent -> rca-agent -> remediator-agent chain."""
    ctx = await req.json()
    log.info(
        "manual dispatch incident %s via trace-agent -> rca-agent -> remediator-agent",
        ctx.get("incident_id"),
    )
    enriched = await enrich_via_trace_agent(ctx)
    rca = await call_agent_a2a(RCA_AGENT_URL, enriched, "rca-agent")
    rca_text = (rca.get("last_event") or rca.get("body") or "")
    rem = {"http_status": 0, "skipped": True}
    if rca_text:
        rem = await call_agent_a2a(
            REMEDIATOR_AGENT_URL, rca_text, "remediator-agent"
        )
    return JSONResponse(
        {"status": "dispatched", "rca_agent": rca, "remediator_agent": rem},
        status_code=200,
    )


@app.post("/rca")
async def rca_only(req: Request):
    """Debug — dispatches to rca-agent only (no remediation)."""
    ctx = await req.json()
    log.info("manual dispatch to rca-agent: %s", ctx.get("incident_id"))
    result = await call_agent_a2a(RCA_AGENT_URL, ctx, "rca-agent")
    return JSONResponse({"status": "dispatched", "rca": result}, status_code=200)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=9094, log_level="info")