# PUKU.md

> Project context for `puku-cli`. Read this on session start so you know
> what this repo is, how to run it, where the live state lives, and what
> to avoid.

## What this repo is

A **multi-agent SRE incident-response POC on Kubernetes (kagent)**.
A cluster of three AI agents (`trace-agent` → `rca-agent` →
`remediator-agent`) detects, diagnoses, and fixes production incidents
on a 3-service demo app (`checkout`, `payment`, `inventory`). Every
write to the cluster is gated by OPA policy. Triggered by a single
click in the `demo-control` UI or by Alertmanager (optional, not wired
to metrics today).

## Layout

```
sre-agent/
├── Makefile                   # single entry point — `make help` lists targets
├── README.md                  # human-facing project readme
├── PUKU.md                    # this file (AI assistant context)
├── .env                       # GEMINI_API_KEY + SLACK_WEBHOOK + GITHUB_PAT
├── apps/
│   ├── demo-service/          # the 3 microservices (Node.js + Express)
│   └── demo-control/          # the visual UI that injects + drives the fix
├── infra/                     # Helm values for Prometheus/Loki/Tempo/Grafana
├── manifests/
│   ├── agents/                # trace-agent.yaml, rca-agent.yaml, remediator-agent.yaml
│   ├── dashboard/             # kubernetes-dashboard + admin-user
│   ├── mcp/                   # RemoteMCPServer CRs (loki/prom/tempo/...)
│   ├── modelconfig/           # gemini-2-flash-lite + kagent-gemini secret
│   ├── rbac/                  # OPA's ServiceAccount + role bindings
│   ├── ui-nodeports.yaml      # high-port NodePorts for grafana/prom/am
│   └── webhook/               # alertmanager-rca-webhook.yaml
├── mcp-servers/               # 8 Python MCP shims (loki, prom, tempo, am,
│                              # policy-mcp-shim, argocd, git, slack)
├── policy/                    # OPA Rego rules + tests
├── scenarios/                 # legacy CLI inject scripts (replaced by UI)
├── scripts/                   # host-side bring-up + port-forwards + token gen
└── docs/                      # archify diagrams + screenshots
```

## How to bring it up

```bash
make poc-up                  # kind cluster + obs stack + demo + agents + OPA
make demo-control             # visual UI (replaces scenarios/*.sh)
./scripts/port-forwards.sh    # host-side port-forwards (run in background)
powershell -File scripts/get-dashboard-token.ps1   # k8s dashboard token
```

Then open:

| URL | What's there |
|---|---|
| http://localhost:15000 | **Demo Control** — inject + watch agents fix it |
| http://localhost:18080 | kagent chat UI |
| http://localhost:18443 | Kubernetes Dashboard (paste the token) |
| http://localhost:13000 | Grafana |
| http://localhost:19091 | Prometheus |
| http://localhost:19092 | Alertmanager |

## Live state (post-`make poc-up`)

| Where | What's running |
|---|---|
| `apps-demo` | `checkout`, `payment`, `inventory` Deployments (2 replicas each), `postgres`, `redis`, `demo-control` |
| `agent-read` | 3 kagent agent Pods (`app=kagent` label, distinguished by `kagent=<name>`), 8 MCP server Pods |
| `agent-write` | OPA + `policy-mcp` (the write-side policy) |
| `kagent` | kagent-controller (8083), kagent-ui (8080), kagent-tools (8084) |
| `observability` | kube-prom-stack (Prom + Grafana + AM), Loki + Promtail, Tempo, OTel collector |

## End-to-end data flow (one click → full recovery)

1. Browser POSTs to `localhost:15000/api/inject/regression?fix=1`
2. `demo-control` (Express in-cluster) PATCHes the `payment` Deployment
   env vars to `v2 / slow / 0.5` (Kubernetes rolls out 2 new Pods)
3. `demo-control` POSTs the IncidentContext to
   `kagent-controller.kagent:8083/api/a2a/agent-read/rca-agent/`
4. rca-agent delegates to **trace-agent** (A2A peer call), reads the
   runbook via `git-mcp`, queries `k8s_get_resources`, emits an
   `RCAFinding` JSON with `proposed_action.tool/op/target_resource`
5. demo-control POSTs the `RCAFinding` to **remediator-agent**
6. remediator-agent calls `policy_evaluate` (→ OPA via `policy-mcp-shim`)
7. On `allow=true`, calls `k8s_rollout action=undo` (→ `kagent-tools` →
   Kubernetes API → rolling update back to v1)
8. demo-control polls `/api/state` at 2 Hz, sees `payment` flip back to
   `v1 / fast / 0%`, UI turns the row green

## Conventions

- **Cluster name:** `sre-poc` (kind). Always `--context kind-sre-poc`.
- **kubectl on Windows:** committed at `bin/kubectl.exe`. `Makefile`
  defaults to running it through Docker (`bitnami/kubectl:1.31`); the
  host binary works too if `kubectl` is on PATH.
- **kagent:** version 0.7.2. A2A peer refs that form cycles
  (`rca-agent ↔ remediator-agent`) are rejected — the **caller** must
  chain them via two sequential A2A POSTs.
- **Models:** Gemini 2 Flash Lite for all 3 agents. Secret:
  `kagent-gemini` in both `kagent` and `agent-read` namespaces (kagent
  0.7.2 looks up ModelConfig in the **agent's** namespace, not the
  controller's).
- **Policy gate:** OPA is the last line of defense — no agent can
  write to the cluster without a `policy_evaluate(action) → allow=true`
  verdict. Rules live in `policy/opa.rego`.
- **Image naming:** `<name>:dev`. Loaded into kind with
  `kind load docker-image`. Pods use `imagePullPolicy: Never`.

## Things to NOT do

- **Don't run `make poc-down`** unless you want to lose all state.
  Restart individual components with `make deploy-missing` or
  `kubectl rollout restart`.
- **Don't replace the UI with the bash scripts.** The demo-control
  visual UI is the canonical driver; `scenarios/*/inject.sh` and
  `scripts/trigger-a2a.sh` exist only for headless/CI use.
- **Don't add `--no-verify` or skip hooks** — pre-commit checks the
  schemas and policy tests.
- **Don't commit secrets.** `.env`, `bin/kubeconfig`, and the kagent
  Gemini secret are all git-ignored. Use `.env.example` as the
  template.
- **Don't edit `manifests/agents/*.yaml` systemMessage casually** —
  every agent's prompt is load-bearing. If you need to change agent
  behavior, change it in the YAML and re-`make kagent`.

## Common workflows

| Goal | Command |
|---|---|
| Tail all agent logs | `make logs` |
| Status of all pods | `make status` |
| Run OPA tests | `make policy-test` |
| Run JSON-schema tests | `make schemas-test` |
| Re-render archify diagrams | `make archify-sre-agent` |
| Get a fresh k8s dashboard token | `kubectl --context kind-sre-poc -n kubernetes-dashboard create token admin-user --duration=24h` |
| Restart demo-control after code change | `docker build -t demo-control:dev apps/demo-control && kind load docker-image demo-control:dev --name sre-poc && kubectl --context kindroll -n apps-demo rollout restart deployment/demo-control` |

## Cluster is currently running

The cluster was started with `make poc-up` and is currently UP (16+ h
uptime as of last check). All UIs are reachable. demo-control Pod is
`1/1 Running` at http://localhost:15000. If a port-forward dies after
a Deployment restart, free the port and re-run:

```bash
powershell -Command "Get-NetTCPConnection -LocalPort 15000 -State Listen |
  ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }"
kubectl --context kind-sre-poc port-forward -n apps-demo svc/demo-control 15000:80
```