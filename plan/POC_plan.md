# POC Plan — Multi-Agent SRE on Kubernetes (kagent)

> **Goal:** Validate that a 3-agent pipeline (`trace-agent` → `rca-agent` → `remediator-agent`) running on **kagent** can detect an incident, perform RCA from traces/logs/metrics, and either auto-remediate or safely halt — end-to-end, in a local cluster, without a human in the loop for the easy path.

Architecture reference: [`docs/images/Kubernetes Multi-Agent Incident Response Architecture.png`](../docs/images/Kubernetes Multi-Agent Incident Response Architecture.png)

---

## 1. Scope

### In scope (POC success criteria)
- 3 kagent agents deployed in a local K8s cluster (`kind`/`minikube`)
- Read-only observability stack: **Prometheus + Loki + Tempo** with OTel-instrumented demo app
- Inter-agent communication over **A2A** using a strict JSON contract
- **MCP servers** for `kubectl`, `tempo`, `loki`, `prometheus`, `argocd`, `slack`
- **OPA policy gate** in front of `remediator-agent`
- Slack notification on every run (RCA + action taken)
- **2 inject scenarios**: (a) auto-fixable regression, (b) blocked high-risk issue
- Reproducible from a single `make poc-up` command

### Out of scope (deferred)
- Multi-cluster / multi-tenant
- Long-running learning / fine-tuning of agents
- Custom model training or hosted fine-tuned LLM
- Cost attribution, chargeback, FinOps
- Integration with real PagerDuty / on-call rotations
- Persistent storage of RCA beyond 7 days

---

## 2. High-Level Design

```
  ┌────────────────────┐
  │ Prometheus /       │
  │ Alertmanager       │
  └────────┬───────────┘
           │ webhook
           ▼
  ┌─────────────────────────────────────────────────────────┐
  │            Kubernetes Cluster (kind / minikube)          │
  │                                                          │
  │   kagent Controller                                     │
  │   ┌────────────┐   A2A   ┌────────────┐   A2A   ┌────────────┐ │
  │   │trace-agent │◄──────►│ rca-agent  │◄──────►│remediator  │ │
  │   │ (read-only)│ gather │ (reason)   │ propose│(scoped RW) │ │
  │   └─────┬──────┘        └─────┬──────┘        └──────┬─────┘ │
  │         │ MCP                 │ MCP                  │ MCP   │
  └─────────┼─────────────────────┼──────────────────────┼──────┘
            ▼                     ▼                      ▼
       Observability         Argo CD / Git          Namespaced writes
       (Tempo/Loki/Prom)     (history/runbooks)     (kubectl/Argo/Helm)
            │                     │                      │
            └──────── ┌───────────┴──────────────────────┘
                       ▼
                  OPA policy gate
                       │
                       ▼
                  Slack / PagerDuty
```

### Agents & permissions

| Agent | Role | MCP tools | Cluster perms |
|---|---|---|---|
| `trace-agent` | Signal gatherer | `kubectl`(RO), `tempo`, `loki`, `prometheus` | `get,list,watch` cluster-wide |
| `rca-agent`   | Reasoner       | `argocd`, `git`, `runbook` (all read)        | `get,list` on apps, rollouts |
| `remediator-agent` | Applier | `kubectl`(RW, ns-scoped), `argocd`(rollback), `helm` | `patch,rollout.restart,scale` in `app-*` namespaces only |

### Inter-agent contract (JSON, validated with ajv)
- `IncidentContext` — what `trace-agent` returns
- `RCAFinding` — what `rca-agent` returns
- `RemediationAction` — what `remediator-agent` consumes
- All tool/MCP outputs **echoed verbatim** for trace IDs, log lines, metric names — no paraphrasing

---

## 3. Deliverables

| # | Deliverable | Path |
|---|---|---|
| D1 | POC plan (this doc) | `plan/POC_plan.md` |
| D2 | Architecture diagram | `docs/images/Kubernetes Multi-Agent Incident Response Architecture.png` |
| D3 | Inter-agent JSON schemas | `schemas/{incident-context,rca-finding,remediation-action}.json` |
| D4 | Sample demo app (instrumented) | `apps/demo-service/` |
| D5 | Observability stack configs | `infra/{prometheus,loki,tempo,otelcollector}.json` |
| D6 | MCP server configs (kagent CRDs) | `manifests/mcp/*.yaml` |
| D7 | Agent CRs (3) | `manifests/agents/*.yaml` |
| D8 | OPA policy (gate) | `policy/sre.rego` |
| D9 | Slack notifier (MCP) | `manifests/mcp/slack-mcp.yaml` |
| D10 | Incident inject scripts | `scenarios/{regression,db-failure}/inject.sh` |
| D11 | End-to-end run script | `Makefile` (`make poc-up`, `make poc-down`, `make inject`) |
| D12 | Demo recording | `docs/screenshots/` or Loom link in `plan/results.md` |

---

## 4. Phases & Timeline (5 working days)

### Day 1 — Cluster + Observability baseline
**Done when:** `kubectl get pod -A` shows a healthy stack (kagent, prometheus, loki, tempo, demo-app), and a `make inject latency` produces visible data in Grafana.

1. `kind create cluster --name sre-poc`
2. Install kube-prometheus-stack, Loki, Tempo, OTel Collector (Helm)
3. Deploy `apps/demo-service` (Node.js + OTel SDK) with intentional variety:
   - `/api/checkout` (calls `/api/payment`, `/api/inventory`)
   - `/api/payment` (depends on Postgres)
   - `/api/inventory` (depends on Redis)
4. Add Grafana dashboards (latency p95, error rate, request volume)
5. Wire Alertmanager → webhook placeholder (we'll point this at kagent on Day 3)

### Day 2 — kagent + MCP servers
**Done when:** Each MCP server is reachable from inside the cluster and responds to a manual A2A call.

1. Install kagent (Helm) with OpenAI/Anthropic API key as a K8s Secret
2. Deploy MCP server CRs:
   - `kubectl-mcp` (uses a ServiceAccount with `view` ClusterRole)
   - `tempo-mcp`, `loki-mcp`, `prometheus-mcp`
   - `argocd-mcp` (read-only)
   - `slack-mcp` (write to a single test channel)
3. Sanity-test each MCP from `kubectl exec` against a busybox pod
4. Build the **JSON schemas** (D3) and validate with `ajv` in a CI test

### Day 3 — Three agents + A2A wiring
**Done when:** Sending "investigate checkout latency" to `rca-agent` returns a valid `RCAFinding` JSON, having called `trace-agent` first.

1. Author the 3 `Agent` CRs with prompts from §5
2. Configure A2A: `rca-agent.tools` includes an A2A call to `trace-agent`
4. Define a `Webhook` resource so Alertmanager can start an `rca-agent` run
5. Add per-agent RBAC + namespace isolation (`trace-agent` and `rca-agent` in `agent-read` ns, `remediator-agent` in `agent-write`)
6. Smoke test: ask each agent a question via the kagent UI; verify tool calls land in audit log

### Day 4 — OPA gate + Slack notifications
**Done when:** A low-confidence RCA results in an "auto-fix skipped, PR opened" outcome in Slack, with no cluster write.

1. Deploy OPA as a sidecar / standalone
2. Implement `policy/sre.rego`:
   - `allow` iff `confidence >= 0.7` AND `risk <= "medium"` AND `action ∉ {kubectl delete cluster-scoped}` AND target namespace in allow-list
3. Build a tiny `policy-mcp` that wraps OPA and exposes `evaluate(RemediationAction) → {allow, reason}`
4. `remediator-agent` calls `policy-mcp.evaluate(action)` before any write
5. Wire Slack MCP to post on each agent run (start, decision, outcome)
6. Verify blocked scenario logs a "denied" Slack message and opens a stub PR via `git-mcp`

### Day 5 — Inject scenarios + demo
**Done when:** Both scenarios produce the expected outcome in Slack, and `plan/results.md` is populated.

1. **Scenario A — auto-fixable regression**
   - Inject: roll out v2 of `payment` with a bug that returns 500 on slow paths
   - Expect: trace-agent gathers errors → rca-agent identifies "v2 deploy, error spike" with confidence 0.9 → policy allows → remediator does `kubectl rollout undo` → Slack posts success
2. **Scenario B — blocked high-risk**
   - Inject: simulate DB connection failure (drop a network policy)
   - Expect: trace-agent gathers → rca-agent proposes `kubectl delete networkpolicy` (high risk) → policy blocks → Slack posts "blocked, ticket opened"
3. Capture screenshots / Loom into `docs/screenshots/`
4. Fill `plan/results.md` with metrics, observations, lessons

---

## 5. Agent Prompts (sketches)

### `trace-agent`
```
You are trace-agent. Given {service, window, severity}, return ONLY a JSON
IncidentContext object. Use MCP tools to gather:
  - top N failing traces from tempo
  - matching error log bursts from loki
  - relevant metrics from prometheus
Rules:
  - Echo trace_ids and log lines verbatim from tool responses.
  - Never invent IDs.
  - Never modify cluster state.
Output schema: schemas/incident-context.json
```

### `rca-agent`
```
You are rca-agent. Receive IncidentContext from the previous agent.
Cross-reference with:
  - Argo CD MCP (recent deploys in the window)
  - Runbook MCP (known patterns)
Return ONLY an RCAFinding JSON with: probable_cause, evidence[],
risk (low|medium|high), confidence (0..1), proposed_action.
Rules:
  - Cite evidence by source + ID.
  - If evidence is thin, set confidence <= 0.4 and risk = high.
Output schema: schemas/rca-finding.json
```

### `remediator-agent`
```
You are remediator-agent. Receive RCAFinding. Before any write:
  1. Build a RemediationAction JSON (schemas/remediation-action.json).
  2. Call policy-mcp.evaluate(action).
  3. If allow=false, stop and report the denial reason.
  4. If allow=true, execute via the appropriate MCP tool.
Never use kubectl delete on cluster-scoped resources.
Prefer rollout undo > scale > patch, in that order.
Always log the action to slack-mcp before and after execution.
```

---

## 6. Policies (OPA / Rego sketch)

```rego
package sre.remediation

default allow = false

allow {
  input.confidence >= 0.7
  input.risk != "high"
  not cluster_scoped_delete(input.action)
  namespace_allowed(input.action.target_namespace)
}

cluster_scoped_delete(a) {
  a.tool == "kubectl"
  a.op == "delete"
  a.target_namespace == "ok"
}

namespace_allowed(ns) {
  ns == "apps-demo"
}
```

---

## 7. Observability for the POC itself

We dogfood our own stack: instrument the agents and MCP servers with OTel so we can see, in Grafana:
- Tokens used per agent run
- Latency per agent hop
- A2A message sizes
- Policy decisions (allow / deny + counts)
- Slack delivery success rate

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| LLM hallucinates a trace ID | Schemas + verbatim echo rule + post-hoc verifier that trace IDs exist in Tempo |
| A2A context bloat blows token budget | Strict JSON contracts; truncate large lists with explicit "more available" flag |
| Remediator overreach | OPA gate + small command allow-list + per-namespace RBAC |
| Flaky local cluster (kind) | `make poc-reset` target that tears down + recreates everything from scratch |
| LLM provider outage | POC supports `--provider ollama` for fully local inference |
| Alertmanager not firing in tests | Manual `make inject` triggers a synthetic alert via the same webhook |

---

## 9. Success Metrics

| Metric | Target |
|---|---|
| Auto-remediation success rate (Scenario A, 5 runs) | ≥ 4 / 5 |
| False auto-remediations on Scenario B (5 runs) | 0 |
| Mean time from alert to Slack message | < 90 s |
| Total token cost per full RCA | reportable (not blocking) |
| Policy denials correctly block high-risk actions | 5 / 5 |
| End-to-end reproducibility from `make poc-up` | yes, single command |

---

## 10. How to Run

```bash
# Prereqs: kind, helm, kubectl, jq, an LLM API key in env
export OPENAI_API_KEY=sk-...      # or ANTHROPIC_API_KEY
export SLACK_WEBHOOK_URL=https://hooks.slack.com/...

make poc-up         # bring up cluster + stack + agents
make inject         # runs Scenario A (auto-fixable)
make inject-high    # runs Scenario B (blocked)
make poc-down       # tear down
```

---

## 11. After the POC (what we'd explore next)

- Add `cost-agent` (rightsizing / unused resources) — read-only MCP for `metrics-server`, `kube-state-metrics`
- Add `security-agent` (ImageVulnerability, RBAC drift)
- Replace synthetic injects with **real SLO error budget burn** as the trigger
- Move from per-agent prompts to a small **fine-tuned router model** that picks which agent(s) to run
- Persistent incident memory (vector store of past RCAs for similarity lookup)

---

## 12. Open Questions

1. Which LLM provider do we standardize on for the POC — and do we need on-prem (Ollama) as the default for the customer?
2. Is Slack the right notifier, or do we need to integrate with the customer's existing on-call tool first?
3. Do we expose agents as a long-lived service (always on) or only spin them up on alert (cost vs. cold-start)?
5. Where does the audit log live — kagent's built-in, or push to the customer's existing SIEM?

---