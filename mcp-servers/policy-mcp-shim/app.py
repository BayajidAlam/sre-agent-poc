"""policy-mcp-shim — wraps the existing policy-mcp (HTTP POST /tools/policy_evaluate)
behind an MCP-protocol StreamableHTTP server.

Tool: policy_evaluate(action) — calls the existing policy-mcp and returns
{allow, reason, deny_reasons, raw} as JSON string.
"""
import os
import json
import httpx
from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse
from starlette.requests import Request
from starlette.applications import Starlette
from starlette.routing import Mount, Route

POLICY_URL = os.environ.get(
    "POLICY_URL",
    "http://policy-mcp.agent-write.svc.cluster.local:80/tools/policy_evaluate",
)

mcp = FastMCP("policy-mcp-shim")


@mcp.tool()
async def policy_evaluate(action) -> str:
    """Evaluate a RemediationAction against the OPA sre.rego policy.

    `action` may be either a JSON string or a dict (some MCP clients
    serialize JSON object args as native dicts). We normalize to a string
    before forwarding to the upstream policy-mcp HTTP endpoint.

    The action must conform to schemas/remediation-action.json (or the
    minimum subset: tool, op, target_namespace, target_resource).
    Returns: {allow, reason, deny_reasons, raw}
    """
    # Normalize dict/list to JSON
    if isinstance(action, (dict, list)):
        action = json.dumps(action)
    if not isinstance(action, str):
        action = str(action)
    async with httpx.AsyncClient(timeout=5.0) as c:
        r = await c.post(
            POLICY_URL,
            headers={"Content-Type": "application/json"},
            content=action,
        )
        r.raise_for_status()
        return r.text


async def healthz(_request: Request):
    return JSONResponse({"status": "ok", "tools": ["policy_evaluate"]})


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