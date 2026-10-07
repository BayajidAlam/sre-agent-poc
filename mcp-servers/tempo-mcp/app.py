"""tempo-mcp — Tempo HTTP API as MCP tools (StreamableHTTP).

Tools: tempo_search (tags + values), tempo_trace_by_id, tempo_search_traces.
"""
import os
import httpx
from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse
from starlette.requests import Request
from starlette.applications import Starlette
from starlette.routing import Mount, Route

TEMPO_URL = os.environ.get(
    "TEMPO_URL",
    "http://tempo.observability.svc.cluster.local:3200",
)

mcp = FastMCP("tempo-mcp")


@mcp.tool()
async def tempo_search(tags: str, min_duration: str = "", limit: int = 20) -> str:
    """Find trace IDs matching tag set. tags is JSON: {"service.name":"payment"}."""
    import json
    params = {
        "tags": tags,
        "limit": limit,
    }
    if min_duration:
        params["minDuration"] = min_duration
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{TEMPO_URL}/api/search", params=params)
        r.raise_for_status()
        return r.text


@mcp.tool()
async def tempo_trace_by_id(trace_id: str) -> str:
    """Fetch a single trace by ID (JSON)."""
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{TEMPO_URL}/api/traces/{trace_id}")
        r.raise_for_status()
        return r.text


@mcp.tool()
async def tempo_search_traces(query: str, limit: int = 20, start: int = 0, end: int = 0) -> str:
    """TraceQL query: search traces via Tempo's TraceQL endpoint."""
    params = {"q": query, "limit": limit}
    if start:
        params["start"] = start
    if end:
        params["end"] = end
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{TEMPO_URL}/api/search", params=params)
        r.raise_for_status()
        return r.text


async def healthz(_request: Request):
    return JSONResponse({"status": "ok", "tools": ["tempo_search", "tempo_trace_by_id", "tempo_search_traces"]})


mcp_sub_app = mcp.streamable_http_app()
app = Starlette(
    routes=[
        Route("/healthz", healthz),
        Mount("/", app=mcp_sub_app),
    ],
    lifespan=mcp_sub_app.router.lifespan_context,
)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")