#!/usr/bin/env bash
# =============================================================================
#  scripts/trigger-a2a.sh — send a synthetic incident to the trace-agent via
#  the kagent controller's A2A endpoint, and stream the JSON-RPC response.
#
#  Requires:
#    - The kagent controller to be installed (make kagent).
#    - A kubectl port-forward to kagent-controller:8083 (the script will start
#      one on $A2A_PORT if not already up).
#    - A valid OPENAI_API_KEY in the kagent-openai secret for the trace-agent
#      to actually call OpenAI; otherwise the agent will return a 401 error.
#
#  Usage:
#    bash scripts/trigger-a2a.sh [incident-service]
#    bash scripts/trigger-a2a.sh payment      # default
# =============================================================================
set -euo pipefail

INCIDENT_SERVICE="${1:-payment}"
INCIDENT_ID="inc-$(date +%s)"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KUBECTL_BIN="$ROOT/bin/kubectl.exe"
[[ -x "$KUBECTL_BIN" ]] || KUBECTL_BIN="kubectl"
KUBECTL="$KUBECTL_BIN --context kind-sre-poc"

A2A_PORT="${A2A_PORT:-8083}"

# Start port-forward in background if not already listening on A2A_PORT.
if ! netstat -ano 2>/dev/null | grep -q ":${A2A_PORT} .*LISTENING"; then
  echo "[a2a] port-forward: kagent-controller:${A2A_PORT} -> localhost:${A2A_PORT}"
  $KUBECTL -n kagent port-forward svc/kagent-controller ${A2A_PORT}:8083 --address 0.0.0.0 >/dev/null 2>&1 &
  PF_PID=$!
  sleep 3
  trap 'kill $PF_PID 2>/dev/null || true' EXIT
fi

PAYLOAD=$(cat <<EOF
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{
        "kind": "text",
        "text": "{\"incident_id\":\"${INCIDENT_ID}\",\"service\":\"${INCIDENT_SERVICE}\",\"severity\":\"error\",\"window_start\":\"${NOW}\",\"window_end\":\"${NOW}\"}"
      }]
    }
  }
}
EOF
)

echo "[a2a] POST http://localhost:${A2A_PORT}/api/a2a/agent-read/trace-agent/"
echo "[a2a] payload: ${PAYLOAD}"
echo ""

curl -sS -X POST "http://localhost:${A2A_PORT}/api/a2a/agent-read/trace-agent/" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" | python -m json.tool 2>/dev/null || \
  curl -sS -X POST "http://localhost:${A2A_PORT}/api/a2a/agent-read/trace-agent/" \
    -H 'Content-Type: application/json' \
    -d "$PAYLOAD"