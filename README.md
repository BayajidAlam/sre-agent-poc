# Multi-Agent SRE POC: kagent on Kubernetes

3-agent incident-response pipeline (`trace-agent -> rca-agent -> remediator-agent`)
on [kagent](https://github.com/kagent-dev/kagent), gated by OPA, with read-only
observability on Prometheus + Loki + Tempo. UI-driven by a single click in
`apps/demo-control`.

## Architecture

![architecture](docs/images/sre-agent-multi-agent-incident-response-on-kagent-ui-driven.png)

## Worked example, one click, full recovery

![demo-control UI after auto-fix](docs/images/dashboard.png)

---

## How to run

```bash
export GOOGLE_API_KEY=AIza...        # free at https://aistudio.google.com/apikey
export SLACK_WEBHOOK_URL=https://hooks.slack.com/...    # optional
make poc-up                          # cluster + obs stack + demo + agents + OPA
./scripts/port-forwards.sh           # host-side forwards (background)
# Open the demo-control URL printed by port-forwards.sh
# Click "Inject + Auto-fix: payment v2"
```

If a step in `poc-up` fails partway, finish manually with `bash scripts/deploy-missing.sh`.

---

## Pipeline (one click to recovery)

```
+-------------------+
|   demo-control    |  (apps-demo ns)
+---------+---------+
          |
          | 1. PATCH deployment/payment env (v2, slow, 50% errors)
          | 2. POST IncidentContext -> kagent-controller:8083
          v
+-------------------+
|   kagent Ctrl     |  (v0.7.2)
+---------+---------+
          |
          | 3. A2A dispatch
          v
+-------------------+         +-------------------+
|     rca-agent     |  peer   |   trace-agent     |
|   (reasoner)      |  call   |    (read-only)    |
+---------+---------+ <-----> +-------------------+
          |
          | 4. reads runbook (git-mcp), k8s state
          | 5. emits typed RCAFinding
          v
+-------------------+
|   demo-control    |  (chains the RCAFinding)
+---------+---------+
          |
          | 6. POST RCAFinding -> kagent-controller
          v
+-------------------+
| remediator-agent  |  (scoped RW)
+---------+---------+
          |
          | 7. policy_evaluate(action)
          v
+-------------------+    +-------------+    +---------+
|  policy-mcp-shim  | -> |  policy-mcp | -> |   OPA   |
+-------------------+    +-------------+    +---------+
          |
          | 8. on allow=true: k8s_rollout(action=undo)
          v
+-------------------+
|   kagent-tools    |  (kubectl under the hood)
+---------+---------+
          |
          v
+---------------------------------------+
|  Kubernetes rolls payment back:      |
|       v2 -> v1   (~30s)               |
+---------------------------------------+
          |
          v
   demo-control polls at 2 Hz,
   services table flips back to green
```

**Why the chain is two steps**: kagent 0.7 rejects A2A peer refs that form
cycles (`rca <-> remediator`). The **caller (demo-control) chains them** via
two sequential A2A POSTs.

---

## Folder structure

```
sre-agent/
|-- Makefile                   # single entry point; `make help` lists targets
|-- README.md                  # this file
|-- PUKU.md                    # AI assistant context (not for humans)
|-- apps/
|   |-- demo-service/          # 3 microservices (Node.js + Express)
|   `-- demo-control/          # visual UI: inject + watch agents fix it
|-- infra/                     # Helm values (Prometheus, Loki, Tempo, OTel, Grafana)
|-- manifests/
|   |-- agents/                # trace-agent, rca-agent, remediator-agent
|   |-- dashboard/             # kubernetes-dashboard + admin-user
|   |-- mcp/                   # 8 RemoteMCPServer CRs
|   |-- modelconfig/           # gemini-2-flash-lite + secret
|   |-- rbac/                  # agent-read (RO) + agent-write (scoped RW)
|   |-- ui-nodeports.yaml      # high-port NodePorts for observability UIs
|   `-- webhook/               # AlertmanagerConfig -> rca-agent bridge
|-- mcp-servers/               # 8 Python MCP shims
|-- policy/                    # OPA Rego + policy-mcp (Node.js) + tests
|-- scenarios/                 # legacy CLI inject scripts (replaced by UI)
|-- scripts/                   # bring-up, port-forwards, dashboard token
|-- schemas/                   # A2A JSON contracts (ajv-validated)
|-- tests/                     # ajv + OPA sync + YAML lint
`-- docs/
    |-- archify/               # interactive archify diagram source + render
    `-- images/                # architecture PNG, dashboard screenshot
```

---

## Common workflows

| Goal | Command |
|---|---|
| Bring everything up | `make poc-up` |
| Visual driver | open the demo-control URL from port-forwards.sh |
| Status of all pods | `make status` |
| Tail all agent logs | `make logs` |
| Run schema + policy tests | `make test` |
| Re-render archify diagram | `make archify-sre-agent` |
| Fresh k8s dashboard token | `kubectl --context kind-sre-poc -n kubernetes-dashboard create token admin-user --duration=24h` |
| Tear down | `make poc-down` |

---

## UIs

The port-forwards script (`./scripts/port-forwards.sh`) prints every URL on
startup, with the correct host binding for your machine (host IP on Windows
to bypass `wslrelay`, or `127.0.0.1` on Linux/macOS).

| UI | What it is |
|---|---|
| demo-control | the visual driver (inject + watch) |
| kagent chat UI | controller chat |
| Kubernetes Dashboard | cluster admin UI (token login) |
| Grafana | dashboards + Explore for Prom/Loki/Tempo |
| Prometheus | metrics + alerts |
| Alertmanager | alert routing |

---

## Safety guarantees

1. **Schema enforcement**: every A2A message validated with `ajv`.
2. **OPA policy gate**: `policy_evaluate` blocks writes outside the allow-list
   (`apps-demo`, `agent-write`), with confidence >= 0.7, risk != high.
3. **Namespace isolation**: `agent-read` SA is `view` cluster-wide;
   `agent-write` SA is scoped to specific verbs in `apps-demo`.
4. **Default-deny**: if OPA errors or times out, the wrapper returns
   `allow:false` (verified by smoke test).

---

## Conventions

- Cluster: `sre-poc` (kind). Always `--context kind-sre-poc`.
- LLM: Gemini 2 Flash Lite. Switch to OpenAI by editing
  `manifests/modelconfig/`.
- Image naming: `<name>:dev`, loaded with `kind load docker-image`.

---

## Out of scope

Multi-cluster, fine-tuning, real PagerDuty, persistent RCA beyond 7 days.
