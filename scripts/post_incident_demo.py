#!/usr/bin/env python3
"""Posts an incident-resolution summary to Slack via slack-mcp's webhook path.

Runs inside the slack-mcp pod so the new SLACK_WEBHOOK_URL forwarding logic fires.
This is what remediator-agent does after a successful remediation.
"""
import sys
sys.path.insert(0, "/app")
import asyncio
from app import slack_post_message

TEXT = """\
:fire: *SRE POC incident resolved* (via agent code path)

*RCA:* payment v2 rollout caused 50% errors + 8s latency on /checkout
*Fix applied:* `kubectl rollout undo deployment/payment -n apps-demo`
*Confidence:* 0.9
*Risk:* medium
*Policy decision:* allow=true

:white_check_mark: payment service has been rolled back to v1.

_(This was posted by calling the slack_post_message function from app.py \u2014 \
the same function remediator-agent calls after a successful remediation.)_\
"""

if __name__ == "__main__":
    result = asyncio.run(slack_post_message(channel="#sre-poc", text=TEXT))
    print("slack_post_message returned:", result)