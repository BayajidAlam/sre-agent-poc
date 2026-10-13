"""slack-mcp — exposes Slack chat.postMessage as an MCP tool.

Forwards to:
  1. The in-cluster slack-recorder service (always — for replay/audit).
  2. A real Slack incoming webhook (optional — set SLACK_WEBHOOK_URL).
"""
import os
import logging
import httpx
from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse
from starlette.requests import Request
from starlette.applications import Starlette
from starlette.routing import Mount, Route

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("slack-mcp")

SLACK_URL = os.environ.get(
    "SLACK_URL",
    "http://slack-recorder.agent-read.svc.cluster.local:80/chat.postMessage",
)
SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "").strip()

mcp = FastMCP("slack-mcp")


@mcp.tool()
async def slack_post_message(channel: str, text: str) -> str:
    """Post a Slack message to `channel` with `text`. Returns {ok, ts, channel}."""
    # Read env lazily so it reflects the pod's actual env even after late inject.
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    log.info("slack_post_message channel=%s webhook_set=%s", channel, bool(webhook_url))

    # 1) Best-effort write to the in-cluster recorder (audit/replay). The
    #    recorder is optional — if it doesn't exist (DNS failure) we log
    #    a warning and continue, so the real-Slack webhook still fires.
    recorder_body = ""
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            recorder_resp = await c.post(
                SLACK_URL, json={"channel": channel, "text": text}
            )
            recorder_resp.raise_for_status()
            recorder_body = recorder_resp.text
    except Exception as e:
        log.warning("slack recorder forward failed (continuing): %s", e)

    # 2) Optionally forward to a real Slack incoming webhook (fire-and-forget).
    #    NOTE: Slack incoming webhooks are bound to a single channel at creation
    #    time. Sending a `channel` param that disagrees with that binding causes
    #    Slack to return `channel_not_found` (404). So we only send `text` here
    #    — the channel is decided by whichever channel the webhook was set up
    #    for in the Slack UI.
    if webhook_url:
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                wh_resp = await c.post(
                    webhook_url,
                    json={"text": text},
                )
                log.info(
                    "slack webhook -> %s (requested_channel=%s)",
                    wh_resp.status_code,
                    channel,
                )
        except Exception as e:
            log.warning("slack webhook forward failed: %s", e)
    else:
        log.warning("slack webhook not configured (SLACK_WEBHOOK_URL empty)")

    return recorder_body


@mcp.tool()
async def slack_list_messages() -> str:
    """List previously recorded messages (debug)."""
    base = SLACK_URL.replace("/chat.postMessage", "")
    async with httpx.AsyncClient(timeout=5.0) as c:
        r = await c.get(f"{base}/messages")
        r.raise_for_status()
        return r.text


async def healthz(_request: Request):
    return JSONResponse({"status": "ok", "tools": ["slack_post_message", "slack_list_messages"]})


mcp_sub_app = mcp.streamable_http_app()
# Starlette's `lifespan` arg needs an async context manager. The MCP sub-app
# exposes one via `mcp_sub_app.router.lifespan_context` (older FastMCP) but on
# newer versions the right attr is `mcp_sub_app.lifespan`. Try both.
_lifespan = getattr(mcp_sub_app, "lifespan", None) or getattr(
    mcp_sub_app.router, "lifespan_context", None
)
app = Starlette(
    routes=[
        Route("/healthz", healthz),
        Mount("/", app=mcp_sub_app),
    ],
    lifespan=_lifespan,
)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")