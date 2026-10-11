# Multi-Agent SRE POC — kagent on Kubernetes

3-agent incident-response pipeline (`trace-agent → rca-agent → remediator-agent`)
on [kagent](https://github.com/kagent-dev/kagent), gated by OPA, with read-only
observability on Prometheus + Loki + Tempo. UI-driven by a single click in
`apps/demo-control` (http://localhost:15000).

![architecture](docs/images/sre-agent-multi-agent-incident-response-on-kagent-ui-driven.png)

![demo-control UI after auto-fix](docs/images/dashboard.png)

---

## TL;DR

```bash
export GOOGLE_API_KEY=AIza...        # free at https://aistudio.google.com/apikey
export SLACK_WEBHOOK_URL=https://hooks.slack.com/...    # optional
make poc-up                          # cluster + obs stack + demo + agents + OPA
./scripts/port-forwards.sh           # host-side forwards (run in background)
# Open http://localhost:15000 → click "Inject + Auto-fix: payment v2"
```

If a step in `poc-up` fails partway, finish manually with `bash scripts/deploy-missing.sh`.

---

## Architecture

```
Prometheus / Alertmanager / Loki / Tempo / Grafana   (observability ns)
                    │                ▲
              fires │                │ PromQL / LogQL / TraceQL
                    ▼                │
             Alertmanager ──▶ kagent Ctrl (v0.7.2)
                                  │ A2A
                          ┌───────┼────────────────────┐
                          ▼       ▼                    ▼
                      trace-agent → rca-agent → remediator-agent
                       (RO)        (reasoner)    (scoped RW)
                          │           │              │
                          ▼           ▼              ▼
                     tempo/loki/   argocd/git/   kagent-tools (kubectl)
                     prom shims    k8s_get       policy-mcp-shim
                     (agent-read)  (agent-read)           │
                                                          ▼
                                              policy-mcp → OPA Rego
                                              (agent-write, default-deny)
```

**Trigger path** — `apps/demo-control` (Node UI in `apps-demo` ns) is the
canonical driver. One click:
1. PATCHes the `payment` Deployment env (`APP_VERSION=v2`, `LATENCY_PROFILE=slow`,
   `ERROR_RATE=0.5`) — Kubernetes rolls out 2 Pods
2. POSTs `IncidentContext` to `kagent-controller:8083/api/a2a/agent-read/rca-agent/`
3. rca-agent delegates to **trace-agent** (A2A peer call), reads git runbook,
   queries k8s state, emits typed `RCAFinding`
4. demo-control POSTs the `RCAFinding` to **remediator-agent**
5. remediator-agent calls `policy_evaluate` (→ OPA via `policy-mcp-shim`)
6. On `allow=true`, calls `k8s_rollout action=undo` (→ `kagent-tools` →
   rolling update back to v1)
7. UI polls at 2 Hz, services table flips back to `🟢 v1` automatically

kagent 0.7 rejects A2A peer refs that form cycles (`rca ↔ remediator`), so
**the caller (demo-control) chains them** via two sequential A2A POSTs.

The Alertmanager → webhook → A2A bridge is wired (`manifests/webhook/`) as an
alt trigger, but no `PrometheusRule` matches the inject today.

---

## Layout

| Path | What it is |
|---|---|
| `apps/demo-service/` | Node.js + Express: `/api/checkout` → `/api/payment`, `/api/inventory` |
| `apps/demo-control/` | In-cluster Node UI at :15000 — visual inject + agent fix loop |
| `infra/` | Helm values for Prometheus, Loki, Tempo, OTel Collector, Grafana |
| `manifests/agents/` | 3 Agent CRs (trace-agent, rca-agent, remediator-agent) |
| `manifests/mcp/` | 8 `RemoteMCPServer` CRs + a kagent-tools alias |
| `manifests/rbac/` | agent-read (RO) and agent-write (scoped RW) bindings |
| `manifests/dashboard/` | Official Kubernetes Dashboard + admin-user |
| `manifests/modelconfig/` | `gemini-2-flash-lite` ModelConfig + Gemini secret (in `kagent` and `agent-read`) |
| `manifests/webhook/` | AlertmanagerConfig → rca-agent webhook bridge |
| `policy/` | OPA Rego (`sre.rego`) + `policy-mcp` (Node.js) wrapper |
| `mcp-servers/_base/` | Shared Python base image for all 8 MCP shims |
| `mcp-servers/<shim>/` | 8 Python MCP shims (prometheus, loki, tempo, alertmanager, argocd, git, slack, policy-mcp-shim) |
| `schemas/` | A2A JSON contracts (incident-context, rca-finding, remediation-action) |
| `scenarios/` | Legacy CLI inject scripts (replaced by `apps/demo-control` UI) |
| `scripts/` | Bring-up, port-forwards, dashboard token, recovery |
| `docs/archify/` | Interactive architecture diagram (`sre-agent.architecture.json` → `.html`) |
| `Makefile` | Single-command orchestration (incl. `archify-*` targets) |

---

## Conventions

- **Cluster:** `sre-poc` (kind). Always `--context kind-sre-poc`.
- **kubectl on Windows:** `bin/kubectl.exe` (host binary) or `bitnami/kubectl:1.31`
  via Docker (Makefile default).
- **kagent:** 0.7.2. `apiVersion: kagent.dev/v1alpha2`, `kind: RemoteMCPServer`
  (not the old `MCPServer`).
- **LLM:** Gemini 2 Flash Lite. Set `GOOGLE_API_KEY` in `.env`. Switch to
  OpenAI by editing `manifests/modelconfig/`.
- **Policy gate:** OPA is the last line of defense — no agent can write to the
  cluster without `policy_evaluate(action) → allow=true`. Rules in
  `policy/opa.rego` (allow-list + confidence ≥ 0.7 + risk ≠ high).
- **Image naming:** `<name>:dev`, loaded into kind with
  `kind load docker-image`. Pods use `imagePullPolicy: Never`.
- **Don't replace the UI with bash scripts** — `apps/demo-control` is the
  canonical driver; `scenarios/*/inject.sh` exist for headless/CI only.

---

## Bring-up details

### Host port allocation (Windows + wslrelay gotcha)

`wslrelay.exe` binds to `127.0.0.1:<port>` for many high ports, so `localhost`
fails for the observability NodePorts. Use the **host's IPv4 address** (from
`ipconfig`) instead of `localhost`, or run the port-forwards via
`./scripts/port-forwards.sh`:

| UI | Working URL |
|---|---|
| **demo-control** | http://localhost:15000 |
| **kagent chat UI** | http://localhost:18080 |
| **Kubernetes Dashboard** | https://localhost:18443 (token login) |
| **Grafana** | http://\<host-IP\>:13000 (admin / admin) |
| **Prometheus** | http://\<host-IP\>:19090 |
| **Alertmanager** | http://\<host-IP\>:19093 |
| **Loki / Tempo** | API only — use Grafana → Explore |

### Kubernetes Dashboard token

```bash
kubectl --context kind-sre-poc -n kubernetes-dashboard create token admin-user --duration=24h
# or on Windows: powershell -File scripts/get-dashboard-token.ps1
```

Browser will warn about self-signed cert — accept it, paste the token.

### Prometheus / Alertmanager auth

This stack runs **no auth** (no `web.authentication` set in
`infra/prometheus/values.yaml`). If re-enabled later, retrieve from secrets:

```bash
kubectl -n observability get secret kube-prom-prometheus -o jsonpath='{.data.basic-auth-admin}' | base64 -d; echo
kubectl -n observability get secret kube-prom-alertmanager -o jsonpath='{.data.basic-auth-admin}' | base64 -d; echo
```

Username is `admin` for both.

---

## Safety guarantees (defense in depth)

1. **Schema enforcement** — every A2A message validated with `ajv` before consumption.
2. **Verbatim echo rule** — `trace-agent` cannot invent trace IDs; the prompt forbids it.
3. **OPA policy gate** — `policy_evaluate` blocks writes outside the allow-list
   (`apps-demo`, `agent-write`), with confidence ≥ 0.7, risk ≠ high.
4. **Namespace isolation** — `agent-read` SA has `view` cluster-wide;
   `agent-write` SA is scoped to specific verbs in `apps-demo`.
5. **Default-deny** — if OPA errors or times out, the wrapper returns
   `allow:false` (verified by smoke test).

---

## What we tested

```
$ make test
6/6 ajv schema tests passed
6/6 OPA policy-sync checks passed
45/45 YAML lint checks passed
$ make status   # (after make poc-up)
pods/kagent-controller = 1/1 Running
pods/kagent-ui        = 1/1 Running
modelconfig/gemini-2-flash-lite = model: gemini-2.0-flash-lite
agents/trace-agent, rca-agent, remediator-agent  READY=True ACCEPTED=True
9/9 RemoteMCPServer CRs ACCEPTED=True
A2A handshake (LIVE): POST /api/a2a/agent-read/trace-agent/ -> JSON-RPC task
Live MCP tool calls: prom_query 'up' -> real kube-prometheus data,
                      policy_evaluate -> allow for rollout.undo, deny for risky
Live policy-gate test:
  Scenario A (rollout.undo, low risk, conf=0.9)  -> allow: TRUE  -> v2 → v1
  Scenario B (delete NP, high risk)               -> allow: FALSE -> NP preserved
  Scenario B (delete, cluster-scope)              -> allow: FALSE -> default-deny
  Scenario B (low confidence)                     -> allow: FALSE -> default-deny
```

---

## Known gaps vs. the original plan

The plan was written against an early kagent API. The shipping 0.7.2 API
required significant manifest updates:

| Plan said | We shipped | Why |
|---|---|---|
| `apiVersion: kagent.io/v1alpha1` | `kagent.dev/v1alpha2` | Project moved from `kagent.io` to `kagent.dev` |
| `kind: MCPServer` (inline deploy) | `kind: RemoteMCPServer` | kagent 0.7 separates MCP lifecycle from referencing it |
| `kind: Webhook` CR for Alertmanager | HTTP POST instead | No `Webhook` CR in installed CRDs |
| MCP images `ghcr.io/kagent-org/*` | 8 self-hosted Python shims | Those images aren't publicly available |
| OpenAI as default | Gemini 2 Flash Lite | Free tier (15 RPM / 1500 RPD) covers the POC |

All 3 Agent CRs, the kagent controller, OPA + policy-mcp, the 8 MCP shims, the
demo app, and the full observability stack deploy cleanly. The LIVE policy gate
test passes end-to-end.

---

## Common workflows

| Goal | Command |
|---|---|
| Tail all agent logs | `make logs` |
| Status of all pods | `make status` |
| Run OPA tests | `make policy-test` |
| Run JSON-schema tests | `make schemas-test` |
| Re-render archify diagrams | `make archify-sre-agent` |
| Fresh k8s dashboard token | `kubectl --context kind-sre-poc -n kubernetes-dashboard create token admin-user --duration=24h` |
| Restart demo-control after code change | `docker build -t demo-control:dev apps/demo-control && kind load docker-image demo-control:dev --name sre-poc && kubectl --context kind-sre-poc -n apps-demo rollout restart deployment/demo-control` |

---

## Archify (interactive diagrams)

The repo wires up [Archify](https://github.com/tt-a1i/archify) globally.
Source: `docs/archify/sre-agent.architecture.json`. Rendered HTML is git-ignored;
regenerate with `make archify-sre-agent` and open `docs/archify/sre-agent.architecture.html`.

```bash
make archify-doctor                    # verify install
make archify-sre-agent                 # generate the runtime diagram
make archify-incident-flow             # render the 3-agent workflow diagram
```

---

## Out of scope

Multi-cluster, fine-tuning, real PagerDuty, persistent RCA beyond 7 days.
See the original plan §1 for the full list.
