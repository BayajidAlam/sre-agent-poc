# Multi-Agent SRE POC — kagent on Kubernetes

3-agent incident-response pipeline (`trace-agent → rca-agent → remediator-agent`) running on [kagent](https://github.com/kagent-dev/kagent), gated by OPA, with read-only observability on Prometheus + Loki + Tempo.

See [`plan/POC_plan.md`](plan/POC_plan.md) for the full plan and architecture diagram at [`docs/images/Kubernetes Multi-Agent Incident Response Architecture.png`](docs/images/Kubernetes%20Multi-Agent%20Incident%20Response%20Architecture.png). For a live, interactive runtime diagram, run `make archify-sre-agent` and open [`docs/archify/sre-agent.architecture.html`](docs/archify/sre-agent.architecture.html) (rendered from [`docs/archify/sre-agent.architecture.json`](docs/archify/sre-agent.architecture.json)).

For a worked end-to-end example of the pipeline (inject → rca-agent → remediator-agent → policy ALLOW → rollout undo → recovery), see [`docs/images/dashboard.png`](docs/images/dashboard.png) — a screenshot of the **demo-control** UI after one click of "Inject + Auto-fix: payment v2". Annotated walkthrough under [Visual demo](#visual-demo).

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

## Visual demo

The included `apps/demo-control` UI (http://localhost:15000 after
`make demo-control && ./scripts/port-forwards.sh`) is the canonical
way to drive the pipeline. It shows live cluster state and an
activity feed of every agent action, so a single click of an "Inject"
button runs the **full** chain:

```text
  click "Inject + Auto-fix: payment v2"
      │
      ▼
  demo-control PATCHes the payment Deployment
      │   (Kubernetes rolls out 2 Pods on v2 — payment now 50% error rate)
      │
      ▼
  demo-control POSTs IncidentContext → kagent-controller → rca-agent
      │
      ▼
  rca-agent: tool call agent_read__NS__trace_agent   (delegate to trace-agent)
  rca-agent: tool call git_recent_commits
  rca-agent: tool call git_get_file (runbooks/payment-regression.md)
  rca-agent: tool call k8s_get_resources
      │
      ▼
  rca-agent emits RCAFinding  { probable_cause, evidence, risk, confidence,
                                 proposed_action: { tool: kubectl, op: rollout.undo,
                                                    target_resource: deployment/payment } }
      │
      ▼
  demo-control POSTs the RCAFinding → kagent-controller → remediator-agent
      │
      ▼
  remediator-agent: tool call policy_evaluate(action)  → OPA: { allow: true }
  remediator-agent: tool call k8s_rollout(action=undo)  → Kubernetes rolling update
  remediator-agent: tool call slack_post_message         → optional notification
      │
      ▼
  payment rolls back to v1, error rate drops to 0%
```

The screenshot below is the demo-control UI captured at the end of
exactly that flow (after the 30s recovery):

![demo-control UI after auto-fix of payment v2](docs/images/dashboard.png)

**What the screenshot shows, top to bottom:**

- **Header pills** — `np: clear` (no NetworkPolicy active), `task: done`
  (last fix completed), `last poll: 01:06:55` (2 s polling is live).
- **4 buttons** — `Inject + Auto-fix: payment v2` and
  `Inject + Auto-fix: DB egress block` chain the inject into the
  agent fix; `Trigger Agent Fix (no inject)` is the manual override;
  `Reset all to v1` rolls everything back manually.
- **Services (live) table** — all three are `🟢 healthy / v1 / fast / 0% / 2-2`
  because the agents already rolled payment back from v2.
- **Task summary** — `[completed] fix remediation applied: kubectl.rollout.undo
  deployment/payment 44s (started 20:19:46)`. Confirms the run took
  44 s end-to-end and the action was the expected `rollout.undo`.
- **Agent activity feed** (newest at top in this build) — the full
  transcript of the run, in order:
  1. `rca-agent → dispatching IncidentContext to rca-agent` (UI-driven)
  2. `rca-agent → tool call: agent_read__NS__trace_agent` (delegation)
  3. `rca-agent → tool call: git_recent_commits, git_get_file, k8s_get_resources`
  4. `rca-agent → RCAFinding: ... → kubectl.rollout.undo deployment/payment`
  5. `remediator-agent → dispatching RCAFinding to remediator-agent`
  6. `remediator-agent → tool call: policy_evaluate` (the OPA gate)
  7. `remediator-agent → tool call: k8s_rollout` (the actual cluster write)
  8. `remediator-agent → tool call: slack_post_message` (notification, optional)
  9. `remediator-agent → policy ALLOW — executed kubectl.rollout.undo on deployment/payment`

The single `WARN` in the feed is `slack_post_message returned error:
Name or service not known` — harmless: this POC has no real Slack
webhook configured, so the optional notification step fails. The
cluster write still succeeded; the rollout undo completed and the
services table is now back to v1.

The `Clear log` button in the top-right of the activity section empties
the in-memory event ring buffer (server-side) and pushes a single
confirmation event so you can reset the feed between demo runs
without restarting the pod.

## What's in here

| Path | What it is |
|---|---|
| `schemas/` | A2A JSON contracts (incident-context, rca-finding, remediation-action) — validated by ajv |
| `apps/demo-service/` | Node.js demo with `/api/checkout` → `/api/payment`, `/api/inventory` |
| `infra/` | Helm values for Prometheus, Loki, Tempo, OTel Collector, Grafana dashboard |
| `manifests/mcp/` | kagent `RemoteMCPServer` CRs (prometheus, loki, tempo, alertmanager, argocd, git, slack, policy-mcp-shim) + a kagent-tools alias |
| `manifests/agents/` | The 3 Agent CRs with prompts from plan §5 |
| `manifests/rbac/` | agent-read (RO) and agent-write (scoped RW) bindings |
| `manifests/dashboard/` | Official Kubernetes Dashboard (the cluster's own UI) + admin-user |
| `policy/` | OPA policy + policy-mcp wrapper (Node.js) |
| `mcp-servers/_base/` | Shared Python base image (FROM shim-base:dev) used by all 8 MCP shims |
| `mcp-servers/<shim>/` | One Python MCP shim per backend (prometheus, loki, tempo, alertmanager, argocd, git, slack, policy-mcp-shim) |
| `scenarios/` | `regression/inject.sh` (Scenario A), `db-failure/inject.sh` (Scenario B) — legacy CLI inject scripts; the `apps/demo-control` UI replaces them for browser use |
| `apps/demo-control/` | In-cluster Node.js UI at http://localhost:15000 — visual inject + agent fix loop. See [Visual demo](#visual-demo) |
| `tests/` | ajv schema tests, OPA sync, YAML lint |
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
45/45 YAML lint checks passed
+ kagent controller bring-up (v0.7.2, gemini-2-flash-lite):
    pods/kagent-controller = 1/1 Running
    pods/kagent-ui        = 1/1 Running
    modelconfig/gemini-2-flash-lite = model: gemini-2.0-flash-lite
+ kagent Agent CRs (v1alpha2, Declarative, ns: agent-read):
    agents/trace-agent      READY=True ACCEPTED=True
    agents/rca-agent        READY=True ACCEPTED=True
    agents/remediator-agent READY=True ACCEPTED=True
+ 9/9 RemoteMCPServer CRs ACCEPTED=True (prometheus, loki, tempo,
    alertmanager, argocd, git, slack, policy-mcp-shim, kagent-tools)
+ A2A handshake (LIVE trace-agent via kagent-controller:8083):
    POST /api/a2a/agent-read/trace-agent/ -> JSON-RPC task object
    containing the agent's tool calls (tempo_search, loki_query,
    prom_query) and a schema-valid IncidentContext result.
+ Live MCP tool calls (via the 8 rebuilt shims):
    prometheus prom_query 'up'  -> real kube-prometheus data
    policy policy_evaluate      -> allow for rollout.undo,
                                   deny for low-confidence / cluster-scoped
+ LIVE cluster policy-gate test (after make poc-up):
    Scenario A (rollout.undo, low risk, conf=0.9) -> allow: TRUE  -> payment rolled back v2->v1
    Scenario B (kubectl delete NP, high risk)    -> allow: FALSE -> NetworkPolicy preserved
    Scenario B (kubectl delete, cluster=ok ns)    -> allow: FALSE -> default-deny
    Scenario B (low confidence)                  -> allow: FALSE -> default-deny
```

| Test | What it proves |
|---|---|
| **ajv schema tests** | All 3 A2A JSON contracts accept valid payloads and reject malformed ones |
| **OPA sync test** | The `policy/sre.rego` source and the bundled copy in `policy/opa.yaml` haven't drifted |
| **YAML lint** | All 45 K8s manifests parse cleanly (no tabs, even indentation) |
| **Live A2A** | trace-agent accepts a real JSON-RPC `message/send`, invokes MCP tools, returns a valid `IncidentContext` |
| **Live MCP tools** | Each of the 8 shims responds to the MCP `initialize` + `tools/list` handshake; `prom_query` and `policy_evaluate` return real results |
| **LIVE policy gate** | OPA `sre.rego` + policy-mcp correctly allow `rollout.undo` and deny all 3 risky patterns; the actual cluster write only happens for the allow case |

## Known gaps vs. the original plan

The plan (`plan/POC_plan.md`) was written against an early/proposed kagent API. The
shipping kagent 0.7.2 API required significant manifest updates:

| Plan said | We shipped | Why |
|---|---|---|
| `apiVersion: kagent.io/v1alpha1` | `apiVersion: kagent.dev/v1alpha2` | The kagent project moved from `kagent.io` to `kagent.dev` and bumped to v1alpha2 |
| `kind: MCPServer` (inline deploy) | `kind: RemoteMCPServer` (points at an MCP server URL) | kagent 0.7 separates MCP server lifecycle from referencing it |
| `kind: Webhook` CR for Alertmanager | removed (HTTP POST instead) | No `Webhook` CR in installed CRDs — alertmanager POSTs to the kagent controller's HTTP endpoint instead |
| MCP server image: `ghcr.io/kagent-org/*` | 8 self-hosted Python shims under `mcp-servers/` | Those images are not publicly available; we build the shims in-cluster and reference their `*.svc.cluster.local:80/mcp` URLs |
| Full agent prompts in `systemPrompt` field | minimal `description` only | The `systemPrompt`/`mcpServers`/`systemMessage` keys were renamed/moved between kagent versions; getting them right requires the kagent controller running and matching examples |
| OpenAI as default LLM | Gemini 2.0 Flash Lite | Free tier (15 RPM / 1500 RPD) covers the POC. Set `OPENAI_API_KEY` in `.env` + switch `manifests/kagent-values-gemini.yaml` to use `providers.openAI` to use OpenAI instead. |

The **3 Agent CRs, the kagent controller (v0.7.2), OPA + policy-mcp, the 8 MCP shims, the demo app, and the full
observability stack (Prometheus + Alertmanager + Grafana + Loki + Tempo + OTel) all
deploy cleanly and the LIVE policy gate test passes**. As of this iteration, the
controller is installed and all three Agent CRs reach `READY=True, ACCEPTED=True`;
the A2A handshake has been verified end-to-end (POST `/api/a2a/agent-read/trace-agent/`
returns a JSON-RPC task object that includes the agent's tool-call attempts and a
schema-valid `IncidentContext`).

**Known limits vs. the original plan:**

| Item | Status | Notes |
|---|---|---|
| policy-mcp as a ToolServer | **Shipped** | `policy-mcp-shim` (`mcp-servers/policy-mcp-shim/`) wraps the existing Node.js `policy-mcp` HTTP endpoint behind an MCP StreamableHTTP server, so agents can call `policy_evaluate` as a normal MCP tool. |
| Cross-namespace peer ref `agent-write → agent-read` | **Workaround applied** | All 3 agents + 7 of the 8 shims live in `agent-read`; only `policy-mcp` and OPA sit in `agent-write` (where the upstream policy-mcp service already lives). |
| Single LLM provider per cluster | **By design** | ModelConfig is per-namespace (`gemini-2-flash-lite` for both `kagent` and `agent-read`); switch by editing the ModelConfig CR, not the Agent CRs. |

**To run an end-to-end LLM-driven scenario test** (after `make poc-up`):

```bash
export GOOGLE_API_KEY=AIza...             # free key from aistudio.google.com/apikey
bash scripts/install-kagent-controller.sh # creates the Secret + ModelConfig
make trigger-a2a payment                 # synthetic A2A request to trace-agent
```

A real `GOOGLE_API_KEY` is required for the agents to actually call Gemini. The free tier covers ~500 full chain runs/day (15 RPM / 1500 RPD).

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
# Open https://<your-host-IP>:19443/  (browser will warn about self-signed
# cert — accept it). On the login page, choose "Token" and paste the printed
# value.
```

Browser will display `Your connection is not private` (NET::ERR_CERT_AUTHORITY_INVALID) — that's the dashboard's auto-generated self-signed cert. Click **Advanced → Proceed to &lt;your-host-IP&gt; (unsafe)** to continue. The token is the login.

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
| **Grafana**    | http://&lt;your-host-IP&gt;:**13000**         |
| **Loki**       | http://&lt;your-host-IP&gt;:**13100**/ready   |
| **Tempo**      | http://&lt;your-host-IP&gt;:**13200**/ready   |
| **Prometheus** | http://&lt;your-host-IP&gt;:**19090**         |
| **Alertmanager** | http://&lt;your-host-IP&gt;:**19093**       |

(Replace `&lt;your-host-IP&gt;` with the IPv4 address shown by `ipconfig` on your Windows host. The IP captured during POC verification on the original author's host was 192.168.0.102.)

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
   Prometheus + Alertmanager + Loki + Tempo
                  │            ▲
            firing │            │ PromQL/LogQL/TraceQL
            rules  ▼            │
            ┌──────────┐    ┌───┴───────────────────────────────────────┐
            │ Alertmgr │───▶│ kagent Ctrl (v0.7.2)                       │
            └──────────┘    │                                           │
                            │  A2A dispatch                              │
                            │  ┌──────────┐ A2A ┌──────────┐ A2A ┌─────┴──┐
                            │  │trace-agt │────▶│ rca-agent│────▶│ remediator│
                            │  │  (RO)    │     │ (reason) │     │ (scoped RW)│
                            │  └────┬─────┘     └────┬─────┘     └────┬─────┘
                            │       │ MCP            │ MCP            │ MCP
                            │       ▼                ▼                ▼
                            │   tempo/loki/prom   argocd/git     kagent-tools (kubectl)
                            │   shims in agent-read ns            policy-mcp-shim
                            │                                          │
                            │                                          ▼
                            │   ┌────────────────────────────────────┐
                            └──▶│ OPA Rego (sre.rego)  ◀── policy-mcp │ (agent-write ns)
                                └────────────────────────────────────┘
                                               ▲
                                               │ allow/deny
                                               │
                                          remediator-agent
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