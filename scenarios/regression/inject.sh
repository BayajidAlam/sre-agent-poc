#!/usr/bin/env bash
# =============================================================================
#  Scenario A — auto-fixable regression
#
#  What it does:
#    1. Rolls out payment v2 with intentionally degraded behavior
#       (slow latency + 50% error rate).
#    2. Generates traffic so Prometheus sees the regression.
#    3. Fires a synthetic webhook to Alertmanager → kagent rca-agent.
#    4. Expect: rca-agent → remediator-agent → policy allows rollout.undo.
#    5. Verifies the deployment rolled back to v1.
#
#  Idempotency: can be re-run; cleans up after itself.
# =============================================================================
set -euo pipefail

# Use the host kubectl from ./bin/ (downloads via bootstrap script)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KUBECTL_BIN="$ROOT/bin/kubectl.exe"
[[ -x "$KUBECTL_BIN" ]] || KUBECTL_BIN="kubectl"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
kctl() { "$KUBECTL_BIN" --context kind-sre-poc "$@"; }
KUBECTL="kctl"

NS="apps-demo"

say()  { printf "\n\033[36m[SCENARIO-A]\033[0m %s\n" "$*"; }
die()  { printf "\n\033[31m[FAIL]\033[0m %s\n" "$*" >&2; exit 1; }
ok()   { printf "  \033[32m[OK]\033[0m %s\n" "$*"; }

say "0. Pre-flight checks"
${KUBECTL} get ns ${NS} >/dev/null 2>&1 || die "namespace ${NS} not found; run 'make poc-up' first"
${KUBECTL} get deploy payment -n ${NS} >/dev/null 2>&1 || die "payment deploy not found"

say "1. Rolling out payment v2 (degraded)"
${KUBECTL} set env deploy/payment -n ${NS} APP_VERSION=v2 LATENCY_PROFILE=slow ERROR_RATE=0.5
${KUBECTL} rollout status deploy/payment -n ${NS} --timeout=120s
ok "payment is now v2 with slow + 50% error"

say "2. Generating traffic for ~30s"
for i in $(seq 1 60); do
  curl -s -o /dev/null -w "%{http_code} " "http://checkout.${NS}.svc.cluster.local/api/checkout" 2>/dev/null \
    || curl -s -o /dev/null -w "%{http_code} " "http://127.0.0.1:8080/api/checkout" 2>/dev/null \
    || true
  sleep 0.5
done
echo
ok "traffic generation done"

say "3. Firing synthetic alert (webhook)"
PAYLOAD=$(cat <<'JSON'
{
  "version": "4",
  "status": "firing",
  "alerts": [{
    "status": "firing",
    "labels": { "alertname": "HighErrorRate", "service": "payment", "namespace": "apps-demo", "severity": "critical" },
    "annotations": { "summary": "payment 500s above 25% threshold after v2 rollout", "description": "Payment service v2 deployment started at $(date) is returning 50% errors with 8s latency on /checkout. Investigate and consider rollback." }
  }]
}
JSON
)
WEBHOOK_URL=${ALERTMANAGER_WEBHOOK_URL:-http://kube-prom-kube-prometheus-alertmanager.observability:9093/api/v1/alerts}
curl -sS -X POST -H "Content-Type: application/json" -d "${PAYLOAD}" "${WEBHOOK_URL}" \
  && ok "alert posted to ${WEBHOOK_URL}" \
  || say "(no Alertmanager reachable — agents can be triggered manually via kagent UI)"

say "4. Waiting up to 90s for auto-remediation"
ROLLED_BACK=""
for i in $(seq 1 18); do
  sleep 5
  CUR_VER=$(${KUBECTL} get deploy payment -n ${NS} -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="APP_VERSION")].value}' 2>/dev/null || echo "")
  if [[ "${CUR_VER}" == "v1" ]]; then ROLLED_BACK="yes"; break; fi
done

if [[ "${ROLLED_BACK}" == "yes" ]]; then
  ok "payment rolled back to v1 — auto-remediation succeeded"
  exit 0
else
  die "payment is still at ${CUR_VER:-?} — agents did not remediate in time"
fi