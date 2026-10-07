#!/usr/bin/env bash
# deploy-missing.sh - bring up demo app, RBAC, policy, agents, and MCP servers.
# Run after a fresh `make poc-up` if the bootstrap script died early (e.g. OTel
# chart not found) and you need to finish the rest of the stack.

set -euo pipefail

cd "$(dirname "$0")/.."
export KUBECONFIG="${KUBECONFIG:-$PWD/bin/kubeconfig}"
KUBECTL="$PWD/bin/kubectl.exe"
if [[ ! -x "$KUBECTL" ]]; then
  KUBECTL="kubectl"
fi

run() { "$KUBECTL" --context kind-sre-poc "$@"; }

echo "[deploy] creating namespaces"
run create namespace apps-demo    --dry-run=client -o yaml | run apply -f -
run create namespace agent-read  --dry-run=client -o yaml | run apply -f -
run create namespace agent-write --dry-run=client -o yaml | run apply -f -

echo "[deploy] RBAC"
run apply -f manifests/rbac/

echo "[deploy] demo app"
run apply -n apps-demo -f apps/demo-service/k8s/

echo "[deploy] OPA + policy-mcp"
run apply -n agent-write -f policy/opa.yaml
run apply -n agent-write -f manifests/mcp/policy-mcp-deployment.yaml

echo "[deploy] kagent CRDs"
run create namespace kagent --dry-run=client -o yaml | run apply -f -
helm upgrade --install kagent-crds oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds \
  --version 0.6.0 -n kagent --wait --timeout 5m 2>&1 | tail -3 || \
  echo "[deploy] (skip) kagent CRDs install"

echo "[deploy] MCP server CRs"
for f in manifests/mcp/*.yaml; do
  [[ "$f" == *"policy-mcp-deployment.yaml"* ]] && continue
  run apply -f "$f" 2>&1 | tail -3 || echo "[deploy] (skip) $f"
done

echo "[deploy] Agent CRs"
for f in manifests/agents/*.yaml; do
  run apply -f "$f" 2>&1 | tail -3 || echo "[deploy] (skip) $f"
done

echo "[deploy] done"
run get pod -A