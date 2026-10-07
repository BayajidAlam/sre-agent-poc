"""slack-recorder — tiny HTTP service that pretends to be Slack's chat.postMessage.

POST /chat.postMessage with {channel, text, attachments} appends to /data/messages.jsonl.
GET  /messages returns the recorded messages (debug aid).
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from fastapi import FastAPI, Request

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
MESSAGES_FILE = DATA_DIR / "messages.jsonl"

app = FastAPI()


@app.get("/healthz")
def healthz():
    return {"status": "ok", "backend": "slack-recorder (stub)"}


@app.post("/chat.postMessage")
async def chat_post_message(req: Request):
    body = await req.json()
    record = {
        "ok": True,
        "channel": body.get("channel"),
        "ts": datetime.now(timezone.utc).isoformat(),
        "message": {"text": body.get("text", "")},
    }
    with MESSAGES_FILE.open("a") as f:
        f.write(json.dumps({"received": body, "responded": record}) + "\n")
    return record


@app.get("/messages")
def messages():
    if not MESSAGES_FILE.exists():
        return {"items": []}
    return {"items": [json.loads(line) for line in MESSAGES_FILE.read_text().splitlines() if line.strip()]}