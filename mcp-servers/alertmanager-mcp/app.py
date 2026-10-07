"""alertmanager-mcp — Alertmanager v2 API as MCP tools.

Tools: am_list_alerts (active + silenced), am_silences, am_status.
"""
import os
import httpx
from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse
from starlette.requests import Request
from starlette.applications import Starlette
from starlette.routing import Mount, Route

AM_URL = os.environ.get(
    "AM_URL",
    "http://kube-prom-kube-prometheus-alertmanager.observability.svc.cluster.local:9093",
)

mcp = FastMCP("alertmanager-mcp")


@mcp.tool()
async def am_list_alerts(active: bool = None, silenced: bool = None) -> str:
    """List current alerts. active/silenced filter (both default to None = all)."""
    params = {}
    if active is not None:
        params["active"] = str(active).lower()
    if silenced is not None:
        params["silenced"] = str(silenced).lower()
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{AM_URL}/api/v2/alerts", params=params)
        r.raise_for_status()
        return r.text


@mcp.tool()
async def am_silences() -> str:
    """List active silences."""
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{AM_URL}/api/v2/silences")
        r.raise_for_status()
        return r.text


@mcp.tool()
async def am_status() -> str:
    """Alertmanager cluster status."""
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{AM_URL}/api/v2/status")
        r.raise_for_status()
        return r.text


async def healthz(_request: Request):
    return JSONResponse({"status": "ok", "tools": ["am_list_alerts", "am_silences", "am_status"]})


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