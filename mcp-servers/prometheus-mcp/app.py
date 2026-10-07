"""prometheus-mcp — exposes Prometheus HTTP API as MCP tools (StreamableHTTP).

Tools exposed:
  prom_query(query, time)            — instant PromQL query
  prom_query_range(query, start, end, step) — range query
  prom_label_values(label, matches)    — list label values

Backend: $PROM_URL (default http://kube-prom-kube-prometheus-prometheus.observability.svc.cluster.local:9090)
Transport: StreamableHTTP at /mcp, uvicorn port 8080.
"""
import os
import httpx
from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse
from starlette.requests import Request

PROM_URL = os.environ.get(
    "PROM_URL",
    "http://kube-prom-kube-prometheus-prometheus.observability.svc.cluster.local:9090",
)

mcp = FastMCP("prometheus-mcp")


@mcp.tool()
async def prom_query(query: str, time: str = "") -> str:
    """Run an instant PromQL query. `time` is RFC3339 or empty for now."""
    params = {"query": query}
    if time:
        params["time"] = time
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{PROM_URL}/api/v1/query", params=params)
        r.raise_for_status()
        return r.text


@mcp.tool()
async def prom_query_range(query: str, start: str, end: str, step: str = "30s") -> str:
    """Run a range PromQL query. start/end are RFC3339."""
    params = {"query": query, "start": start, "end": end, "step": step}
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{PROM_URL}/api/v1/query_range", params=params)
        r.raise_for_status()
        return r.text


@mcp.tool()
async def prom_label_values(label: str, match: str = "") -> str:
    """List values for a Prometheus label. Optionally scoped by series selector."""
    params = {}
    if match:
        params["match[]"] = match
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(
            f"{PROM_URL}/api/v1/label/{label}/values", params=params
        )
        r.raise_for_status()
        return r.text


# Healthz route + StreamableHTTP at /mcp via the FastMCP ASGI app.
async def healthz(_request: Request):
    return JSONResponse({"status": "ok", "tools": ["prom_query", "prom_query_range", "prom_label_values"]})


# Compose the ASGI app: healthz at /healthz, MCP app mounted at root for /mcp.
# CRITICAL: we must pass the FastMCP sub-app's lifespan to the parent Starlette
# app, otherwise StreamableHTTPSessionManager never enters its task group and
# every /mcp request fails with "Task group is not initialized".
from starlette.applications import Starlette
from starlette.routing import Mount, Route

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