#!/usr/bin/env bash
# =============================================================================
#  scripts/install-kagent-controller.sh — install the kagent controller chart,
#  create the Gemini API key Secret, and apply the Gemini ModelConfig.
#
#  Idempotent. Safe to re-run.
#
#  Requires:
#    - A reachable kind cluster (this is normally run after make poc-up).
#    - $GOOGLE_API_KEY set in the env to enable the agent -> Gemini path.
#      (Without it, the controller still comes up; agent CRs will just stay
#      NotReady until a Secret is created.)
#
#  Get a free key at https://aistudio.google.com/apikey — free tier covers
#  the POC at 15 RPM / 1500 RPD (~500 full chain runs/day).
#
#  Host CLIs (./bin/helm.exe, ./bin/kubectl.exe) are used if present, else
#  system PATH versions are used.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HELM_BIN="$ROOT/bin/helm.exe"
KUBECTL_BIN="$ROOT/bin/kubectl.exe"
[[ -x "$HELM_BIN" ]]    || HELM_BIN="helm"
[[ -x "$KUBECTL_BIN" ]] || KUBECTL_BIN="kubectl"

KUBECTL="$KUBECTL_BIN --context kind-sre-poc"
CONTROLLER_IMG="ghcr.io/kagent-dev/kagent/controller:0.7.2"
CHART="oci://ghcr.io/kagent-dev/kagent/helm/kagent"
CHART_VERSION="0.7.2"
NS="kagent"

echo "[kagent] pre-pulling controller image (best-effort)..."
docker pull "$CONTROLLER_IMG" >/dev/null 2>&1 || \
  echo "[kagent] (warn) docker pull failed; helm install will retry."

echo "[kagent] ensuring namespace $NS exists"
$KUBECTL create namespace "$NS" --dry-run=client -o yaml | $KUBECTL apply -f -

# Delete the chart-installed default-model-config ModelConfig if it exists.
# When switching providers from OpenAI to Gemini, the CR retains a stale
# `openAI: {...}` block from a previous install which fails the CRD
# validation `provider.openAI must be nil if the provider is not OpenAI`.
# Helm will recreate this CR from the new template (which has openAI: null).
echo "[kagent] removing stale chart-managed default-model-config (will be recreated from new template)"
$KUBECTL -n "$NS" delete modelconfig default-model-config --ignore-not-found

echo "[kagent] installing controller chart ($CHART v$CHART_VERSION) with Gemini provider"
# The custom values file sets providers.openAI=null so the chart-installed
# default-model-config ModelConfig CR doesn't fail validation when the
# provider switches away from OpenAI.
$HELM_BIN upgrade --install kagent "$CHART" \
  --version "$CHART_VERSION" \
  --namespace "$NS" \
  -f "$ROOT/manifests/kagent-values-gemini.yaml" \
  --wait --timeout 12m \
  --set controller.image.tag=0.7.2 \
  --set kagent-tools.enabled=true \
  --set providers.gemini.maxTokens=4096 \
  --set querydoc.enabled=false \
  --set agents.k8s-agent.enabled=false \
  --set agents.kgateway-agent.enabled=false \
  --set agents.istio-agent.enabled=false \
  --set agents.promql-agent.enabled=false \
  --set agents.observability-agent.enabled=false \
  --set agents.argo-rollouts-agent.enabled=false \
  --set agents.helm-agent.enabled=false \
  --set agents.cilium-policy-agent.enabled=false \
  --set agents.cilium-manager-agent.enabled=false \
  --set agents.cilium-debug-agent.enabled=false \
  || { echo "[kagent] (error) helm install failed"; exit 1; }

echo "[kagent] waiting for deployment/kagent controller to be Ready"
$KUBECTL -n "$NS" rollout status deploy/kagent-controller --timeout=180s || \
  echo "[kagent] (warn) controller rollout status not yet Ready; continuing."

# 3. Gemini secret (only if key is supplied)
KEY_VAL="${GOOGLE_API_KEY:-dummy-replace-with-real-key}"
echo "[kagent] creating/updating Gemini secret kagent-gemini (key set: $([[ -n ${GOOGLE_API_KEY:-} ]] && echo yes || echo no))"
$KUBECTL -n "$NS" create secret generic kagent-gemini \
  --from-literal=GOOGLE_API_KEY="$KEY_VAL" \
  --dry-run=client -o yaml | $KUBECTL apply -f -
for ns in agent-read agent-write; do
  $KUBECTL -n "$ns" create secret generic kagent-gemini \
    --from-literal=GOOGLE_API_KEY="$KEY_VAL" \
    --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null 2>&1 || true
done
if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
  echo "[kagent] (warn) GOOGLE_API_KEY is not exported; agents will return 401 from Gemini."
  echo "[kagent]         export GOOGLE_API_KEY=AIza... && bash scripts/install-kagent-controller.sh"
  echo "[kagent]         Free key at https://aistudio.google.com/apikey (no card needed)."
fi

# 4. ModelConfig CR (and per-namespace copies for the Agent CRs).
# The manifest has namespace: kagent hardcoded, so for per-namespace copies
# we sed it to the target namespace (kubectl would otherwise reject with
# "namespace from provided object does not match").
echo "[kagent] applying ModelConfig (manifests/modelconfig/gemini-2-flash-lite.yaml)"
$KUBECTL apply -f "$ROOT/manifests/modelconfig/gemini-2-flash-lite.yaml"
for ns in agent-read agent-write; do
  sed "s/^namespace: kagent/namespace: $ns/" \
    "$ROOT/manifests/modelconfig/gemini-2-flash-lite.yaml" \
    | $KUBECTL apply -f - >/dev/null 2>&1 || true
done

# 5. Agent CRs + MCP CRs (re-apply last)
echo "[kagent] applying MCP server CRs (manifests/mcp/*.yaml)"
for f in "$ROOT"/manifests/mcp/*.yaml; do
  [[ "$f" == *"policy-mcp-deployment.yaml"* ]] && continue
  $KUBECTL apply -f "$f" 2>&1 | tail -1
done
echo "[kagent] applying Agent CRs (manifests/agents/*.yaml)"
for f in "$ROOT"/manifests/agents/*.yaml; do
  $KUBECTL apply -f "$f" 2>&1 | tail -1
done

echo ""
echo "[kagent] cluster state:"
$KUBECTL -n "$NS" get pods,modelconfig -o wide