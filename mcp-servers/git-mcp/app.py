"""git-mcp — serves a small fixture git repo's commit log + files as MCP tools.

The fixture repo is baked into the image at /fixture. We expose:
  - git_recent_commits(limit) → JSON list of recent commits (synthesized)
  - git_get_file(path) → file contents from the fixture
"""
import json
from pathlib import Path
from datetime import datetime, timedelta, timezone
from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse
from starlette.requests import Request
from starlette.applications import Starlette
from starlette.routing import Mount, Route

FIXTURE = Path(__file__).parent / "fixture"

# Synthesized commit log (since the fixture repo isn't a real .git, just files)
SYNTH_COMMITS = [
    {"sha": "v2-deployed",  "author": "alice", "timestamp": "2026-10-05T16:50:00Z", "message": "feat(payment): bump timeout to 1000ms", "files": ["apps/payment/k8s/deployment.yaml"]},
    {"sha": "v1-deployed",  "author": "bob",   "timestamp": "2026-10-04T09:30:00Z", "message": "fix(payment): handle missing customer_id gracefully", "files": ["apps/payment/src/server.js"]},
    {"sha": "v0.9",         "author": "carol", "timestamp": "2026-10-01T11:00:00Z", "message": "chore(deps): bump express to 4.19", "files": ["package.json"]},
    {"sha": "v0.8",         "author": "alice", "timestamp": "2026-09-27T14:20:00Z", "message": "feat(payment): add retry logic", "files": ["apps/payment/src/retry.js"]},
    {"sha": "v0.7",         "author": "bob",   "timestamp": "2026-09-21T08:15:00Z", "message": "docs: add runbook for payment regressions", "files": ["runbooks/payment-regression.md"]},
]

mcp = FastMCP("git-mcp")


@mcp.tool()
async def git_recent_commits(limit: int = 5) -> str:
    """List the most recent commits (from fixture)."""
    return json.dumps({"items": SYNTH_COMMITS[:limit]})


@mcp.tool()
async def git_get_file(path: str) -> str:
    """Read a file from the fixture repo by relative path (e.g. 'README.md', 'runbooks/payment-regression.md')."""
    p = (FIXTURE / path).resolve()
    # Security: ensure path is inside FIXTURE
    if not str(p).startswith(str(FIXTURE.resolve())):
        return json.dumps({"error": "path traversal blocked", "path": path})
    if not p.exists():
        return json.dumps({"error": "not found", "path": path})
    return json.dumps({"path": path, "content": p.read_text()})


async def healthz(_request: Request):
    return JSONResponse({"status": "ok", "tools": ["git_recent_commits", "git_get_file"]})


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