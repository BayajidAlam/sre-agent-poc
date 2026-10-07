"""mcp-sse-proxy — wraps an upstream MCP server that returns plain JSON
(application/json) with an SSE envelope so MCP Python clients (which expect
text/event-stream) can consume it.

Used to make upstream `ghcr.io/kagent-dev/kagent/tools:0.0.12` work with
kagent-adk agents that loop on `Unexpected content type: ""` errors.
"""
import os
import json
import logging
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mcp-sse-proxy")

UPSTREAM_URL = os.environ.get(
    "UPSTREAM_URL",
    "http://kagent-tools.kagent.svc.cluster.local:8084",
)
PROXY_PORT = int(os.environ.get("PROXY_PORT", "8084"))

app = FastAPI()


async def proxy_request(req: Request) -> Response:
    """Pipe the request body to upstream, then rewrite the response into SSE format
    when the client expects text/event-stream."""
    body = await req.body()
    upstream_path = req.url.path
    upstream_qs = req.url.query
    url = f"{UPSTREAM_URL}{upstream_path}"
    if upstream_qs:
        url += f"?{upstream_qs}"
    log.info("proxy %s %s -> %s", req.method, upstream_path, url)
    fwd_headers = {
        k: v for k, v in req.headers.items()
        if k.lower() not in {"host", "content-length"}
    }
    # Force Accept so upstream uses JSON (we'll rewrap as SSE).
    fwd_headers["accept"] = "application/json"
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, read=300.0)) as c:
        upstream_resp = await c.request(
            req.method,
            url,
            headers=fwd_headers,
            content=body,
        )
    upstream_ct = upstream_resp.headers.get("content-type", "")
    upstream_body = upstream_resp.content

    # If client wants SSE and upstream gave plain JSON, wrap it.
    # Don't wrap 202 (notification acks) — those have empty body and MCP expects that.
    wants_sse = "text/event-stream" in req.headers.get("accept", "")
    if (
        wants_sse
        and "text/event-stream" not in upstream_ct
        and upstream_resp.status_code != 202
        and upstream_body
    ):
        # Format as SSE: single "message" event with the JSON body.
        try:
            payload = upstream_body.decode("utf-8")
            json.loads(payload)  # validate
        except Exception:
            payload = json.dumps({"raw": payload})
        sse_body = f"event: message\ndata: {payload}\n\n"

        # Use StreamingResponse to avoid httpx seeing a buffered Content-Length
        # response (which makes it not stream as SSE).
        async def sse_stream():
            yield sse_body.encode("utf-8")

        return StreamingResponse(
            sse_stream(),
            status_code=upstream_resp.status_code,
            media_type="text/event-stream",
            headers={
                "mcp-session-id": upstream_resp.headers.get("mcp-session-id", ""),
                "cache-control": "no-cache",
            },
        )

    # Otherwise pass through (e.g., text/event-stream if upstream already does SSE).
    return Response(
        content=upstream_body,
        status_code=upstream_resp.status_code,
        media_type=upstream_ct or "application/json",
        headers={
            k: v for k, v in upstream_resp.headers.items()
            if k.lower() not in {"content-length", "transfer-encoding", "content-encoding"}
        },
    )


@app.get("/healthz")
def healthz():
    return {"status": "ok", "upstream": UPSTREAM_URL}


# Catch-all router — proxy every path.
@app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def catch_all(full_path: str, request: Request):
    return await proxy_request(request)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PROXY_PORT, log_level="info")