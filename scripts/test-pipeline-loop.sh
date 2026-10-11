#!/usr/bin/env bash
# Send a synthetic incident to trace-agent, then dump the per-agent logs.
set -euo pipefail

CTX=kind-sre-poc
INCIDENT_ID="inc-loop-$(date +%s)"
SERVICE="${1:-payment}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
A2A_URL="http://localhost:8083/api/a2a/agent-read/trace-agent/"

PAYLOAD=$(cat <<EOF
{
  "jsonrpc": "2.0",
  "id": "${INCIDENT_ID}",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{
        "kind": "text",
        "text": "{\"incident_id\":\"${INCIDENT_ID}\",\"service\":\"${SERVICE}\",\"severity\":\"error\",\"window_start\":\"${NOW}\",\"window_end\":\"${NOW}\"}"
      }]
    }
  }
}
EOF
)

echo "[loop] incident_id=${INCIDENT_ID} service=${SERVICE}"
echo "[loop] POST ${A2A_URL}"
echo
RESP=$(curl -sS -X POST "${A2A_URL}" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" 2>&1)
echo "${RESP}" | python -m json.tool 2>/dev/null || echo "${RESP}"

echo
echo "[loop] waiting 25s for the A2A pipeline to complete..."
sleep 25

echo
echo "[loop] === trace-agent log (filtered) ==="
kubectl --context $CTX logs -n agent-read -l app=kagent --tail=80 2>/dev/null \
  | grep -A1 "trace-agent" | tail -40 || true

echo
echo "[loop] === rca-agent log (filtered) ==="
kubectl --context $CTX logs -n agent-read -l app=kagent --tail=80 2>/dev/null \
  | grep -E "rca-agent|RCAFinding|remediator-agent" | tail -40 || true

echo
echo "[loop] === remediator-agent log (filtered) ==="
kubectl --context $CTX logs -n agent-read -l app=kagent --tail=80 2>/dev/null \
  | grep -E "remediator-agent|RemediationAction|policy_evaluate|slack" | tail -40 || true
