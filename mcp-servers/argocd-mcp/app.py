"""argocd-mcp — stub ArgoCD app list as MCP tools.

The POC has no real ArgoCD instance. We serve a static fixture from apps.json
so rca-agent can demonstrate cross-referencing deploy state.
"""
import json
import os
from pathlib import Path
from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse
from starlette.requests import Request
from starlette.applications import Starlette
from starlette.routing import Mount, Route

APPS_FILE = Path(__file__).parent / "apps.json"
APPS = json.loads(APPS_FILE.read_text())

mcp = FastMCP("argocd-mcp")


@mcp.tool()
async def argocd_list_apps() -> str:
    """List Argo CD applications (stubbed)."""
    return json.dumps({"items": APPS})


@mcp.tool()
async def argocd_get_app(name: str) -> str:
    """Get a single Argo CD application by name."""
    matches = [a for a in APPS if a["metadata"]["name"] == name]
    if not matches:
        return json.dumps({"error": f"app {name} not found", "items": []})
    return json.dumps(matches[0])


async def healthz(_request: Request):
    return JSONResponse({"status": "ok", "tools": ["argocd_list_apps", "argocd_get_app"], "stub": True})


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