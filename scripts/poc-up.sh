#!/usr/bin/env bash
# =============================================================================
#  scripts/poc-up.sh — bootstrap a kind cluster + SRE POC stack from scratch.
#
#  What this does:
#    1. Downloads kind/kubectl/helm into ./bin/ if missing
#    2. Creates the kind cluster "sre-poc" using infra/kind-config.yaml
#    3. Builds demo-service + policy-mcp Docker images and loads into kind
#    4. Installs Prometheus stack, Loki, Tempo, OTel Collector via helm
#    5. Deploys demo apps, OPA, MCP servers, agents, RBAC, webhook
#    6. Prints cluster health
#
#  Host requirements: just docker (running).
#  Everything else lives in ./bin/ or runs as Docker containers in the cluster.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p bin

# --- 1. Download host CLIs into ./bin/ ---------------------------------------
if [[ ! -x "$ROOT/bin/kind.exe" ]]; then
  echo "[bootstrap] downloading kind into ./bin/"
  curl -sL -o "$ROOT/bin/kind.exe" \
    "https://github.com/kubernetes-sigs/kind/releases/download/v0.27.0/kind-windows-amd64"
  chmod +x "$ROOT/bin/kind.exe"
fi
if [[ ! -x "$ROOT/bin/kubectl.exe" ]]; then
  echo "[bootstrap] downloading kubectl into ./bin/"
  curl -sL -o "$ROOT/bin/kubectl.exe" \
    "https://dl.k8s.io/release/v1.31.0/bin/windows/amd64/kubectl.exe"
  chmod +x "$ROOT/bin/kubectl.exe"
fi
if [[ ! -x "$ROOT/bin/helm.exe" ]]; then
  echo "[bootstrap] downloading helm into ./bin/"
  curl -sL -o /tmp/helm.zip "https://get.helm.sh/helm-v3.16.3-windows-amd64.zip"
  powershell -Command "Expand-Archive -Force -Path /tmp/helm.zip -DestinationPath $ROOT/bin" >/dev/null
  mv "$ROOT/bin/windows-amd64/helm.exe" "$ROOT/bin/helm.exe"
  rm -rf "$ROOT/bin/windows-amd64" /tmp/helm.zip
fi

KIND_BIN="$ROOT/bin/kind.exe"
KUBECTL_BIN="$ROOT/bin/kubectl.exe"
HELM_BIN="$ROOT/bin/helm.exe"

echo "[bootstrap] kind:    $($KIND_BIN version | head -1)"
echo "[bootstrap] kubectl: $($KUBECTL_BIN version --client | head -1)"
echo "[bootstrap] helm:    $($HELM_BIN version --short)"

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
do_kubectl() { "$KUBECTL_BIN" --context kind-sre-poc "$@"; }
do_helm()    { "$HELM_BIN" "$@"; }

# --- 2. Create kind cluster --------------------------------------------------
CLUSTER_NAME="sre-poc"
if "$KIND_BIN" get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "[bootstrap] cluster $CLUSTER_NAME already exists"
else
  echo "[bootstrap] creating kind cluster $CLUSTER_NAME"
  "$KIND_BIN" create cluster --name $CLUSTER_NAME \
    --config infra/kind-config.yaml --wait 5m
fi

# --- 3. Build + load images ---------------------------------------------------
echo "[bootstrap] building demo-service:dev"
docker build -t demo-service:dev apps/demo-service

echo "[bootstrap] building policy-mcp:dev"
docker build -t policy-mcp:dev policy

echo "[bootstrap] loading images into kind"
"$KIND_BIN" load docker-image demo-service:dev --name $CLUSTER_NAME
"$KIND_BIN" load docker-image policy-mcp:dev   --name $CLUSTER_NAME

# --- 4. Observability stack ---------------------------------------------------
echo "[bootstrap] installing observability stack (Prometheus + Loki + Tempo + OTel)"

do_kubectl create namespace observability --dry-run=client -o yaml | do_kubectl apply -f -

do_helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
do_helm repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || true
do_helm repo update >/dev/null 2>&1

echo "[bootstrap] >> kube-prometheus-stack"
do_helm upgrade --install kube-prom prometheus-community/kube-prometheus-stack \
  -n observability -f infra/prometheus/values.yaml --wait --timeout 25m || \
  echo "[bootstrap] (warn) kube-prom hit timeout — Grafana image pull is slow on Docker Desktop; pods may still come up"

echo "[bootstrap] >> Loki"
do_helm upgrade --install loki grafana/loki \
  -n observability -f infra/loki/values.yaml --wait --timeout 15m

echo "[bootstrap] >> Tempo"
do_helm upgrade --install tempo grafana/tempo \
  -n observability -f infra/tempo/values.yaml --wait --timeout 15m

echo "[bootstrap] >> OTel Collector"
do_helm upgrade --install otel-collector grafana/opentelemetry-collector \
  -n observability -f infra/otelcollector/values.yaml --wait --timeout 15m || \
  echo "[bootstrap] (warn) OTel collector helm install failed (likely a stale repo index) - run scripts/deploy-missing.sh later to retry, or proceed without it"

do_kubectl apply -n observability -f infra/grafana/dashboards/

# --- 4a. UI NodePort services on unused high host ports -----------------------
# Avoids host port collisions with VS Code (3000) and wslrelay (3100/3200/9090)
# on Windows. See manifests/ui-nodeports.yaml + infra/kind-config.yaml.
echo "[bootstrap] >> UI NodePort services (high host ports)"
do_kubectl apply -n observability -f manifests/ui-nodeports.yaml

# --- 4b. Kubernetes Dashboard (official UI for the cluster itself) -------------
echo "[bootstrap] >> Kubernetes Dashboard"
do_kubectl apply -f manifests/dashboard/ 2>&1 | tail -5 || true

# --- 5. Demo app --------------------------------------------------------------
do_kubectl create namespace apps-demo --dry-run=client -o yaml | do_kubectl apply -f -
do_kubectl apply -n apps-demo -f apps/demo-service/k8s/

# --- 6. Policy gate + agents --------------------------------------------------
do_kubectl create namespace agent-read  --dry-run=client -o yaml | do_kubectl apply -f -
do_kubectl create namespace agent-write --dry-run=client -o yaml | do_kubectl apply -f -

do_kubectl apply -f manifests/rbac/
do_kubectl apply -n agent-write -f policy/opa.yaml

# --- 6a. Install kagent CRDs (Agent / RemoteMCPServer / ToolServer) ----------
echo "[bootstrap] >> kagent CRDs"
do_kubectl create namespace kagent --dry-run=client -o yaml | do_kubectl apply -f -
do_helm upgrade --install kagent-crds oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds \
  --version 0.6.0 -n kagent --wait --timeout 5m 2>&1 | tail -5 || \
  echo "[bootstrap] (warn) kagent-crds install skipped"

# Apply policy-mcp (its own Deployment + Service, not a CRD)
do_kubectl apply -n agent-write -f manifests/mcp/policy-mcp-deployment.yaml 2>&1 | tail -3 || true

# Apply MCP/Agent CRs (skip files that don't match current kagent API)
for f in manifests/mcp/*.yaml manifests/agents/*.yaml manifests/webhook/*.yaml; do
  [[ "$f" == *"policy-mcp-deployment.yaml"* ]] && continue
  ${KUBECTL_BIN} --context kind-sre-poc apply -f "$f" 2>&1 | tail -3 || \
    echo "[bootstrap] (skip) $f — does not match installed kagent API"
done

# --- 7. Health summary -------------------------------------------------------
echo ""
echo "[bootstrap] ✓ POC stack ready"
echo ""
do_kubectl get pod -A