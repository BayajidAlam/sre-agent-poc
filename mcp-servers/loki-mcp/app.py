"""loki-mcp — Loki HTTP API as MCP tools (StreamableHTTP).

Tools: loki_query, loki_labels, loki_series.
Backend: $LOKI_URL.
"""
import os
import httpx
from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse
from starlette.requests import Request
from starlette.applications import Starlette
from starlette.routing import Mount, Route

LOKI_URL = os.environ.get(
    "LOKI_URL",
    "http://loki.observability.svc.cluster.local:3100",
)

mcp = FastMCP("loki-mcp")


@mcp.tool()
async def loki_query(query: str, limit: int = 100, direction: str = "backward") -> str:
    """Run a LogQL query (returns logs as JSON)."""
    params = {"query": query, "limit": limit, "direction": direction}
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{LOKI_URL}/loki/api/v1/query", params=params)
        r.raise_for_status()
        return r.text


@mcp.tool()
async def loki_query_range(query: str, start: str, end: str, limit: int = 100) -> str:
    """Run a LogQL range query over [start,end] (RFC3339)."""
    params = {"query": query, "start": start, "end": end, "limit": limit}
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{LOKI_URL}/loki/api/v1/query_range", params=params)
        r.raise_for_status()
        return r.text


@mcp.tool()
async def loki_labels(start: str = "", query: str = "") -> str:
    """List Loki label names (optionally filtered by series selector)."""
    params = {}
    if start:
        params["start"] = start
    if query:
        params["query"] = query
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{LOKI_URL}/loki/api/v1/labels", params=params)
        r.raise_for_status()
        return r.text


async def healthz(_request: Request):
    return JSONResponse({"status": "ok", "tools": ["loki_query", "loki_query_range", "loki_labels"]})


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