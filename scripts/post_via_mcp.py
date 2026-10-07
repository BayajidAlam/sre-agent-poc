#!/usr/bin/env python3
"""Calls slack-mcp's slack_post_message tool over MCP protocol."""
import asyncio, sys, uuid
import httpx

async def main(port: int, text: str, channel: str = "#sre-poc"):
    base_url = f"http://localhost:{port}/mcp/"
    headers_base = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=60.0)) as c:
        # initialize
        r = await c.post(base_url, headers=headers_base, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "demo", "version": "1.0"},
            },
        })
        print("init:", r.status_code)
        sid = r.headers.get("mcp-session-id") or r.headers.get("Mcp-Session-Id")
        if not sid:
            print("no session id, headers:", dict(r.headers))
            return
        print("sid:", sid)
        # initialized notification
        await c.post(base_url, headers={**headers_base, "mcp-session-id": sid},
            json={"jsonrpc": "2.0", "method": "notifications/initialized"})
        # call tool
        r2 = await c.post(base_url,
            headers={**headers_base, "mcp-session-id": sid},
            json={
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {
                    "name": "slack_post_message",
                    "arguments": {"channel": channel, "text": text},
                },
            })
        print("call:", r2.status_code, r2.text[:500])

if __name__ == "__main__":
    import pathlib
    if len(sys.argv) > 1 and pathlib.Path(sys.argv[1]).is_file():
        text = pathlib.Path(sys.argv[1]).read_text()
    else:
        text = sys.argv[1] if len(sys.argv) > 1 else ":fire: SRE POC test"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8084
    asyncio.run(main(port, text))