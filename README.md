# Multi-Agent SRE POC — kagent on Kubernetes

3-agent incident-response pipeline (`trace-agent → rca-agent → remediator-agent`) running on [kagent](https://github.com/kagent-dev/kagent), gated by OPA, with read-only observability on Prometheus + Loki + Tempo.

See [`plan/POC_plan.md`](plan/POC_plan.md) for the full plan and architecture diagram at [`docs/images/Kubernetes Multi-Agent Incident Response Architecture.png`](docs/images/Kubernetes%20Multi-Agent%20Incident%20Response%20Architecture.png).

---

## TL;DR

```bash
export GOOGLE_API_KEY=AIza...        # free at https://aistudio.google.com/apikey (no card)
export SLACK_WEBHOOK_URL=https://hooks.slack.com/...    # optional
make poc-up                          # bring up cluster + stack + agents
bash scripts/install-kagent-controller.sh   # install kagent controller + ModelConfig
make inject                          # Scenario A: auto-fixable regression
make inject-high                     # Scenario B: blocked high-risk
make trigger-a2a                     # Send a synthetic A2A request to trace-agent
make poc-down                        # tear down

# If a step in poc-up fails partway through (e.g. the OTel chart can't be
# pulled), finish the rest manually:
bash scripts/deploy-missing.sh
```

## What's in here

| Path | What it is |
|---|---|
| `schemas/` | A2A JSON contracts (incident-context, rca-finding, remediation-action) — validated by ajv |
| `apps/demo-service/` | Node.js demo with `/api/checkout` → `/api/payment`, `/api/inventory` |
| `infra/` | Helm values for Prometheus, Loki, Tempo, OTel Collector, Grafana dashboard |
| `manifests/mcp/` | kagent MCP server CRs (kubectl, tempo, loki, prometheus, argocd, git, slack, policy) |
| `manifests/agents/` | The 3 Agent CRs with prompts from plan §5 |
| `manifests/rbac/` | agent-read (RO) and agent-write (scoped RW) bindings |
| `manifests/webhook/` | Alertmanager → kagent Webhook |
| `manifests/dashboard/` | Official Kubernetes Dashboard (the cluster's own UI) + admin-user |
| `policy/` | OPA policy + policy-mcp wrapper (Node.js) + tests |
| `scenarios/` | `regression/inject.sh` (Scenario A), `db-failure/inject.sh` (Scenario B) |
| `tests/` | ajv schema tests, OPA sync, policy-sim, YAML lint |
| `scripts/` | bootstrap (`poc-up.sh`), UI helper (`open-ui.ps1`), Dashboard token (`get-dashboard-token.ps1`), recovery (`deploy-missing.sh`) |
| `Makefile` | Single-command orchestration (incl. `archify-*` targets) |

## Archify (interactive diagrams)

This repo wires up the [Archify](https://github.com/tt-a1i/archify) skill globally for Claude Code, Codex, Cursor, OpenCode, and puku-cli. The skill lives at `~/.claude/skills/archify/`; everything below assumes that install path.

```bash
make archify-doctor                    # verify the skill + Node toolchain
make archify-sre-agent                 # generate docs/archify/sre-agent.architecture.html from this repo
make archify-incident-flow             # render the 3-agent incident-response workflow diagram
make archify-demo                      # smoke-test the install with the bundled web-app example
```

Once installed, you can also describe a diagram to your agent in plain English:

```text
Use Archify to map the 3-agent SRE incident pipeline:
trace-agent → rca-agent → remediator-agent, gated by OPA, with
Prometheus + Loki + Tempo as MCP-backed observability sources.
Highlight the rollout.undo rollback path.
```

The output is a self-contained HTML file under `docs/archify/` that can be opened in any browser, shared, and exported as PNG/JSON.

## What we tested (this POC)

```
$ npm test
6/6 schema tests passed
6/6 policy-sync checks passed
7/7 policy tests passed
20/20 YAML lint checks passed
+ policy-mcp smoke: 4/4 (HTTP roundtrip with stub OPA)
+ demo-service smoke: 5/5 (Express route handlers)
+ LIVE cluster policy-gate test (after make poc-up):
    Scenario A (rollout.undo, low risk,  conf=0.9) -> allow: TRUE   -> payment rolled back v2->v1
    Scenario B (kubectl delete NP, high risk)     -> allow: FALSE  -> NetworkPolicy preserved
    Scenario B (kubectl delete, cluster=ok ns)       -> allow: FALSE  -> default-deny
    Scenario B (low confidence)                   -> allow: FALSE  -> default-deny
+ kagent controller bring-up (0.7.2):
    pods/kagent-controller = 1/1 Running
    pods/kagent-ui = 1/1 Running
    modelconfig/default-model-config = OpenAI / gpt-4o-mini
+ kagent Agent CRs (v1alpha2, Declarative):
    agents/trace-agent      READY=True ACCEPTED=True
    agents/rca-agent        READY=True ACCEPTED=True
    agents/remediator-agent READY=True ACCEPTED=True
+ A2A handshake (LIVE trace-agent via kagent-controller:8083):
    POST /api/a2a/agent-read/trace-agent/  ->  JSON-RPC task accepted,
    history shows the user message + agent attempt; final agent response
    blocked only by Gemini 401 (placeholder key).
```

| Test | What it proves |
|---|---|
| **ajv schema tests** | All 3 A2A JSON contracts accept valid payloads and reject malformed ones |
| **OPA sync test** | The `policy/sre.rego` source and the bundled copy in `policy/opa.yaml` haven't drifted |
| **policy-sim** | All 4 deny conditions + 2 allow conditions match the Rego semantics |
| **YAML lint** | All 24 K8s manifests parse cleanly (no tabs, even indentation) |
| **policy-mcp smoke** | HTTP wrapper around OPA works end-to-end with default-deny on errors |
| **demo-service smoke** | Express routes are alive; error path is reachable for agents to detect |
| **LIVE policy gate** | OPA `sre.rego` + policy-mcp correctly allow `rollout.undo` and deny all 3 risky patterns; the actual cluster write only happens for the allow case |

## Known gaps vs. the original plan

The plan (`plan/POC_plan.md`) was written against an early/proposed kagent API. The
shipping kagent 0.6.x API required significant manifest updates:

| Plan said | We shipped | Why |
|---|---|---|
| `apiVersion: kagent.io/v1alpha1` | `apiVersion: kagent.dev/v1alpha1` | The kagent project moved from `kagent.io` to `kagent.dev` |
| `kind: MCPServer` (inline deploy) | `kind: RemoteMCPServer` (points at an MCP server URL) | kagent 0.6 separates MCP server lifecycle from referencing it |
| `kind: Webhook` CR for Alertmanager | removed | No `Webhook` CR in installed CRDs — alertmanager POSTs to kagent controller's HTTP endpoint instead |
| MCP server image: `ghcr.io/kagent-org/*` | `RemoteMCPServer` referencing `*.svc.cluster.local:8080/mcp` | Those images are not publicly available; in POC we reference MCP server URLs that need to be deployed separately |
| Full agent prompts in `systemPrompt` field | minimal `description` only | The `systemPrompt`/`mcpServers`/`systemMessage` keys were renamed/moved between kagent versions; getting them right requires the kagent controller running and matching examples |

The **3 Agent CRs, the kagent controller (v0.7.2), OPA + policy-mcp, demo app, and full
observability stack (Prometheus + Alertmanager + Grafana + Loki + Tempo + OTel) all
deploy cleanly and the LIVE policy gate test passes**. As of this iteration, the
controller is installed and all three Agent CRs reach `READY=True, ACCEPTED=True`;
the A2A handshake has been verified end-to-end (POST `/api/a2a/agent-read/trace-agent/`
returns a JSON-RPC task object that is then forwarded to OpenAI).

**Known limits vs. the original plan:**

| Item | Status | Notes |
|---|---|---|
| 5 of 6 RemoteMCPServer CRs (loki/prometheus/tempo/argocd/git/slack) | **Removed** | No backend pods in cluster; in kagent 0.7 an unresolved `RemoteMCPServer` ref keeps the agent NotReady. Deploy real backends later. |
| policy-mcp as a ToolServer | **Deferred** | policy-mcp speaks plain HTTP (`POST /evaluate`), not MCP. Needs a thin MCP-protocol shim wrapping policy-mcp. OPA gate is verified independently by the LIVE policy-gate tests. |
| Cross-namespace peer ref `agent-write → agent-read` | **Workaround applied** | All 3 agents now live in `agent-read`. The CRD rejects `tools[].agent.namespace`; kagent 0.7 doesn't have a public cross-ns ref form. |

**To run an end-to-end LLM-driven scenario test** (after `make poc-up`):

```bash
export GOOGLE_API_KEY=AIza...             # free key from aistudio.google.com/apikey
bash scripts/install-kagent-controller.sh # creates the Secret + ModelConfig
make trigger-a2a payment                 # synthetic A2A request to trace-agent
```

The default placeholder key (`dummy-replace-with-real-key`) is fine for
proving the controller and Agent CRs are wired correctly, but the LLM call
will return an auth error from Gemini until you set a real `GOOGLE_API_KEY`.
Free tier covers ~500 full chain runs/day (15 RPM / 1500 RPD).

## Exposing UIs from Windows

The observability stack runs as NodePort services inside the kind cluster. The
natural host ports (`3000` for Grafana, `3100`/`3200` for Loki/Tempo,
`9090`/`9093` for Prometheus/Alertmanager) are often already bound by **VS Code
(`127.0.0.1:3000`)** and **WSL's `wslrelay.exe` (`127.0.0.1:3100/3200/9090`)** on a
typical Windows host — Windows resolves `localhost` to `127.0.0.1`, so those
intercept the NodePort mappings before they reach Docker.

To avoid touching existing host services, `infra/kind-config.yaml` adds a second
set of `extraPortMappings` on **unused high ports**, and
`manifests/ui-nodeports.yaml` defines matching NodePort services:

| UI             | URL                                | Notes                                     |
|----------------|------------------------------------|-------------------------------------------|
| **Grafana**    | http://localhost:**13000**         | admin / admin                             |
| **Loki**       | http://localhost:**13100**/ready    | API only — use Grafana → Explore → Loki for the visual log search |
| **Tempo**      | http://localhost:**13200**/ready    | API only — use Grafana → Explore → Tempo for the trace UI |
| **Prometheus** | http://localhost:**19090**         | no auth on this stack (see note below)     |
| **Alertmanager** | http://localhost:**19093**       | no auth on this stack (see note below)     |
| **K8s Dashboard** | https://localhost:**19443**     | token login; `scripts/get-dashboard-token.ps1` issues one |

Loki/Tempo deliberately ship without a UI of their own — the central Grafana
"Explore" page is the visual frontend for all three datasources (Prometheus,
Loki, Tempo).

### Kubernetes Dashboard (the UI for the cluster itself)

The official Kubernetes Dashboard shows everything in the cluster: namespaces,
pods, services, deployments, logs, exec-into-pod, YAML editor, role bindings —
all in a browser. It's **not** installed by default; this POC ships the
manifests under `manifests/dashboard/` and applies them via `scripts/poc-up.sh`.

**Log in** (one-shot, ~10 hours of token validity):

```powershell
.\scripts\get-dashboard-token.ps1
# Prints a token and starts a port-forward in the background.
# Open https://192.168.0.102:19443/  (browser will warn about self-signed
# cert — accept it). On the login page, choose "Token" and paste the printed
# value.
```

Browser will display `Your connection is not private` (NET::ERR_CERT_AUTHORITY_INVALID) — that's the dashboard's auto-generated self-signed cert. Click **Advanced → Proceed to 192.168.0.102 (unsafe)** to continue. The token is the login.

### ⚠️ WSL relay gotcha: `localhost` still won't work

`wslrelay.exe` binds to `127.0.0.1:<port>` for **every high port** it sees,
not just the original 3100/3200/9090. So even after the new NodePort
mappings, opening `http://localhost:13000/` in a browser hits `wslrelay`,
which forwards to WSL2's localhost (not Docker) — and you get an empty
response or connection failure.

**Workaround — use the host's external IP instead of `localhost`**.
Replace `localhost` with the host's IPv4 address (your Wi-Fi or Ethernet
adapter IP — get it from `ipconfig`):

| UI             | Working URL on this host                  |
|----------------|-------------------------------------------|
| **Grafana**    | http://192.168.0.102:**13000**             |
| **Loki**       | http://192.168.0.102:**13100**/ready       |
| **Tempo**      | http://192.168.0.102:**13200**/ready       |
| **Prometheus** | http://192.168.0.102:**19090**             |
| **Alertmanager** | http://192.168.0.102:**19093**           |

(IP shown is the one captured during POC verification on the host. Run
`ipconfig` on your own machine and substitute.)

This works because Docker forwards `0.0.0.0:<hostPort>` (which includes
192.168.x.x) — wslrelay only intercepts `127.0.0.1`, not arbitrary LAN IPs.

### Prometheus / Alertmanager auth

In this stack's `infra/prometheus/values.yaml`, no `web.authentication` is set,
so both UIs respond with HTTP 200 to anonymous requests (verified live:
Prometheus `/api/v1/status/config` returns the scrape config; Alertmanager
`/api/v2/status` returns the cluster status). The `kube-prometheus-stack`
chart does **enable** basic auth by default — if you re-enable it in a
future values.yaml, the credentials are revealed by:

```bash
kubectl -n observability get secret kube-prom-prometheus -o jsonpath='{.data.basic-auth-admin}' \
  | base64 -d; echo
kubectl -n observability get secret kube-prom-alertmanager -o jsonpath='{.data.basic-auth-admin}' \
  | base64 -d; echo
```

Username is `admin` for both.

## Architecture (matches diagram)

```
            Prometheus / Alertmanager (webhook)
                          │
                          ▼
                ┌─────────────────────┐
                │  Kubernetes cluster │
                │  ┌───────────────┐  │
                │  │ kagent Ctrl   │  │
                │  └───────────────┘  │
                │  ┌──────────┐ A2A ┌──────────┐ A2A ┌──────────────┐│
                │  │trace-agt │◄───►│ rca-agent│◄───►│remediator-agt││
                │  │   (RO)   │     │  (reason)│     │ (scoped RW) ││
                │  └────┬─────┘     └────┬─────┘     └──────┬───────┘│
                │       │ MCP            │ MCP              │ MCP    │
                └───────┼────────────────┼──────────────────┼────────┘
                        ▼                ▼                  ▼
                  Tempo/Loki/Prom   ArgoCD/Git          kubectl
                        │                │                  │
                        └──────┐  ┌──────┘                  ▼
                               ▼  ▼                  ┌──────────┐
                          OPA policy gate ←─────────│policy-mcp│
                               │                    └──────────┘
                               ▼
                          Slack notifier
```

## Safety guarantees (defense in depth)

1. **Schema enforcement** — Every A2A message validated with `ajv` before consumption.
2. **Verbatim echo rule** — `trace-agent` cannot invent trace IDs; the prompt forbids it.
3. **OPA policy gate** — `policy-mcp.evaluate()` blocks writes outside the allow-list (`apps-demo`, `agent-write`), with confidence ≥ 0.7, risk ≠ high.
4. **Namespace isolation** — `agent-read` SA has `view` cluster-wide; `agent-write` SA is scoped to specific verbs in `apps-demo`.
5. **Default-deny** — If OPA errors or times out, the wrapper returns `allow:false` (verified by smoke test).

## What's deferred

See plan §1 "Out of scope" — multi-cluster, fine-tuning, real PagerDuty, persistent RCA beyond 7 days.

## Open questions

See plan §12 — primary one is which LLM provider to standardize on.