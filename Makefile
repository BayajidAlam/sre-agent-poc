# =============================================================================
#  Multi-Agent SRE on Kubernetes (kagent) — POC
#  Single-command bring-up, injection, and teardown.
#
#  Prereqs:
#    - kind, helm, kubectl, jq, docker
#    - LLM_API_KEY in env (OPENAI_API_KEY, ANTHROPIC_API_KEY, or use --provider ollama)
#    - SLACK_WEBHOOK_URL in env (optional but recommended)
#
#  Usage:
#    make poc-up        # bring up cluster + stack + agents
#    make inject        # Scenario A: auto-fixable regression
#    make inject-high   # Scenario B: blocked high-risk
#    make status        # show pod health
#    make logs          # tail all agent logs
#    make schemas-test  # run ajv schema tests
#    make poc-down      # tear down cluster
#    make poc-reset     # nuke and recreate from scratch
# =============================================================================

SHELL := /bin/bash
CLUSTER_NAME ?= sre-poc
KIND_CONFIG  ?= infra/kind-config.yaml
# Resolve kubeconfig path — kind uses ~/.kube/config by default.
KUBECONFIG_PATH := $(or $(KUBECONFIG),$(HOME)/.kube/config)
# Both kubectl and helm run inside Docker — host only needs Docker + kind.
KUBECTL_IMG := bitnami/kubectl:1.31
KUBECTL     := docker run --rm --network=host \
                 -v "$(KUBECONFIG_PATH):/root/.kube/config" \
                 -e KUBECONFIG=/root/.kube/config \
                 $(KUBECTL_IMG) kubectl --context kind-$(CLUSTER_NAME)
HELM_IMG    := alpine/helm:3.16.3
HELM        := docker run --rm --network=host \
                 -v "$(KUBECONFIG_PATH):/root/.kube/config" \
                 -e KUBECONFIG=/root/.kube/config \
                 -v "$(CURDIR):/work" -w "/work" \
                 $(HELM_IMG) helm
PROVIDER    ?= openai           # openai | anthropic | ollama
NAMESPACE_AGENTS_READ  := agent-read
NAMESPACE_AGENTS_WRITE := agent-write
NAMESPACE_OBS          := observability
NAMESPACE_DEMO         := apps-demo

export KUBECONFIG := $(KUBECONFIG_PATH)

.PHONY: help
help:                              ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# -----------------------------------------------------------------------------
#  Cluster lifecycle
# -----------------------------------------------------------------------------
.PHONY: poc-up
poc-up: cluster kind-load-images obs-stack demo-stack policy-mcp kagent agents slack-mcp ## Bring up everything
	@echo ">>> POC ready. Try: make inject"
	@$(KUBECTL) get pod -A | head -40

.PHONY: kagent
kagent:                             ## Install kagent controller + create ModelConfig + Agent CRs
	@bash scripts/install-kagent-controller.sh

.PHONY: poc-down
poc-down:                          ## Delete the kind cluster
	@kind delete cluster --name $(CLUSTER_NAME)
	@echo ">>> cluster $(CLUSTER_NAME) deleted"

.PHONY: poc-reset
poc-reset: poc-down poc-up         ## Nuke and rebuild

.PHONY: cluster
cluster:                           ## Create kind cluster
	@if kind get clusters | grep -q "^$(CLUSTER_NAME)$$"; then \
		echo ">>> cluster $(CLUSTER_NAME) already exists"; \
	else \
		kind create cluster --name $(CLUSTER_NAME) --config $(KIND_CONFIG); \
	fi

.PHONY: shim-base
shim-base:                         ## Build the common Python base image all MCP shims share
	@docker build -t shim-base:dev mcp-servers/_base

.PHONY: kind-load-images
kind-load-images: shim-base        ## Load demo + MCP images into kind
	@docker build -t demo-service:dev apps/demo-service
	@kind load docker-image demo-service:dev --name $(CLUSTER_NAME)
	@docker build -t policy-mcp:dev   policy
	@kind load docker-image policy-mcp:dev --name $(CLUSTER_NAME)
	@for shim in prometheus-mcp loki-mcp tempo-mcp alertmanager-mcp policy-mcp-shim argocd-mcp git-mcp slack-mcp; do \
		docker build -t $$shim:dev mcp-servers/$$shim && \
		kind load docker-image $$shim:dev --name $(CLUSTER_NAME); \
	done

# -----------------------------------------------------------------------------
#  Observability stack
# -----------------------------------------------------------------------------
.PHONY: obs-stack
obs-stack:                         ## Install Prometheus + Loki + Tempo + OTel
	@$(KUBECTL) create namespace $(NAMESPACE_OBS) --dry-run=client -o yaml | $(KUBECTL) apply -f -
	@helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
	@helm repo add grafana https://grafana.github.io/helm-charts
	@helm repo update
	@helm upgrade --install kube-prom grafana/kube-prometheus-stack \
		-n $(NAMESPACE_OBS) -f infra/prometheus/values.yaml --wait
	@helm upgrade --install loki grafana/loki \
		-n $(NAMESPACE_OBS) -f infra/loki/values.yaml --wait
	@helm upgrade --install tempo grafana/tempo \
		-n $(NAMESPACE_OBS) -f infra/tempo/values.yaml --wait
	@helm upgrade --install otel-collector grafana/opentelemetry-collector \
		-n $(NAMESPACE_OBS) -f infra/otelcollector/values.yaml --wait
	@$(KUBECTL) apply -n $(NAMESPACE_OBS) -f infra/grafana/dashboards/

# -----------------------------------------------------------------------------
#  Demo app
# -----------------------------------------------------------------------------
.PHONY: demo-stack
demo-stack:                        ## Deploy demo-service + Postgres + Redis
	@$(KUBECTL) create namespace $(NAMESPACE_DEMO) --dry-run=client -o yaml | $(KUBECTL) apply -f -
	@$(KUBECTL) apply -n $(NAMESPACE_DEMO) -f apps/demo-service/k8s/

# -----------------------------------------------------------------------------
#  Policy + MCPs
# -----------------------------------------------------------------------------
.PHONY: policy-mcp
policy-mcp:                        ## Deploy OPA + policy-mcp
	@$(KUBECTL) apply -f manifests/rbac/
	@$(KUBECTL) create namespace $(NAMESPACE_AGENTS_WRITE) --dry-run=client -o yaml | $(KUBECTL) apply -f -
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_WRITE) -f policy/opa.yaml
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_WRITE) -f manifests/mcp/policy-mcp.yaml

.PHONY: agents
agents:                            ## Deploy MCP servers + 3 agents
	@$(KUBECTL) create namespace $(NAMESPACE_AGENTS_READ) --dry-run=client -o yaml | $(KUBECTL) apply -f -
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/mcp/
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/agents/
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/webhook/

.PHONY: mcp-shims
mcp-shims: shim-base               ## Build + load + deploy the 8 MCP shims
	@echo ">>> Building + loading 8 MCP shims"
	@for shim in prometheus-mcp loki-mcp tempo-mcp alertmanager-mcp policy-mcp-shim argocd-mcp git-mcp slack-mcp; do \
		docker build -t $$shim:dev mcp-servers/$$shim && \
		kind load docker-image $$shim:dev --name $(CLUSTER_NAME); \
	done
	@echo ">>> Applying shim Deployments + Services"
	@for shim in prometheus-mcp loki-mcp tempo-mcp alertmanager-mcp policy-mcp-shim argocd-mcp git-mcp slack-mcp; do \
		$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f mcp-servers/$$shim/k8s/; \
	done
	@echo ">>> Applying RemoteMCPServer CRs"
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/mcp/prometheus-mcp.yaml
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/mcp/loki-mcp.yaml
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/mcp/tempo-mcp.yaml
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/mcp/alertmanager-mcp.yaml
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/mcp/policy-mcp-shim.yaml
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/mcp/argocd-mcp.yaml
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/mcp/git-mcp.yaml
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/mcp/slack-mcp.yaml

.PHONY: slack-mcp
slack-mcp:                         ## Deploy Slack notifier
	@$(KUBECTL) apply -n $(NAMESPACE_AGENTS_READ) -f manifests/mcp/slack-mcp.yaml

# -----------------------------------------------------------------------------
#  Scenarios
# -----------------------------------------------------------------------------
.PHONY: inject
inject:                            ## Scenario A: auto-fixable regression
	@bash scenarios/regression/inject.sh

.PHONY: inject-high
inject-high:                       ## Scenario B: blocked high-risk
	@bash scenarios/db-failure/inject.sh

.PHONY: install-controller
install-controller:                ## (Re)install just the kagent controller + ModelConfig
	@bash scripts/install-kagent-controller.sh

.PHONY: trigger-a2a
trigger-a2a:                       ## Send a synthetic A2A request to trace-agent via the controller
	@bash scripts/trigger-a2a.sh

# -----------------------------------------------------------------------------
#  Observability of the POC itself
# -----------------------------------------------------------------------------
.PHONY: status
status:                            ## Show pod health
	@$(KUBECTL) get pod -A

.PHONY: logs
logs:                              ## Tail all agent logs
	@$(KUBECTL) logs -n $(NAMESPACE_AGENTS_READ)  -l app=kagent --tail=100 -f
	@$(KUBECTL) logs -n $(NAMESPACE_AGENTS_WRITE) -l app=kagent --tail=100 -f

.PHONY: policy-test
policy-test:                       ## Run OPA policy tests
	@opa test policy/

.PHONY: schemas-test
schemas-test:                      ## Run ajv schema validation
	@npm test

.PHONY: test
test: schemas-test policy-test     ## Run all tests

# -----------------------------------------------------------------------------
#  Cleanup helpers
# -----------------------------------------------------------------------------
.PHONY: clean-images
clean-images:                      ## Remove local docker images
	@docker rmi -f demo-service:dev policy-mcp:dev 2>/dev/null || true

# -----------------------------------------------------------------------------
#  Archify (https://github.com/tt-a1i/archify) — interactive diagrams from code
#  Installed globally with:  npx -y skills add tt-a1i/archify --skill archify \
#                              --agent claude-code --global --copy --yes
#  Lives at:                 ~/.claude/skills/archify/
# -----------------------------------------------------------------------------
ARCHIFY         ?= node $(HOME)/.claude/skills/archify/bin/archify.mjs
ARCHIFY_OUT_DIR ?= docs/archify

.PHONY: archify-doctor
archify-doctor:                   ## Run archify doctor (verify install + toolchain)
	@$(ARCHIFY) doctor

.PHONY: archify-install
archify-install:                  ## (Re)install the archify skill globally
	@echo "Installing archify skill globally for claude-code..."
	@npx -y skills add tt-a1i/archify --skill archify --agent claude-code --global --copy --yes

.PHONY: archify-demo
archify-demo:                     ## Render the bundled web-app example to verify skill works
	@$(ARCHIFY) deliver architecture $(HOME)/.claude/skills/archify/examples/web-app.architecture.json \
		$(ARCHIFY_OUT_DIR)/web-app.html --quality showcase --open

.PHONY: archify-sre-agent
archify-sre-agent:                ## Generate a runtime architecture diagram of THIS repo into docs/archify/sre-agent.architecture.html
	@mkdir -p $(ARCHIFY_OUT_DIR)
	@$(ARCHIFY) deliver architecture $(ARCHIFY_OUT_DIR)/sre-agent.architecture.json \
		$(ARCHIFY_OUT_DIR)/sre-agent.architecture.html --quality showcase

.PHONY: archify-incident-flow
archify-incident-flow:            ## Render the multi-agent incident-response workflow into a diagram
	@mkdir -p $(ARCHIFY_OUT_DIR)
	@$(ARCHIFY) deliver workflow $(HOME)/.claude/skills/archify/examples/incident-response.workflow.json \
		$(ARCHIFY_OUT_DIR)/incident-response.workflow.html --quality showcase

.PHONY: archify-clean
archify-clean:                    ## Remove generated archify artifacts
	@rm -rf $(ARCHIFY_OUT_DIR)