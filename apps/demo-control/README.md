# Demo Control UI

A small in-cluster web app that gives you a visual interface for the SRE POC
demo loop:

- **See** the current state of `checkout`, `payment`, `inventory` in real time
  (APP_VERSION, LATENCY_PROFILE, ERROR_RATE, replicas).
- **Inject** either failure mode with a button (replaces scenarios/regression/inject.sh
  and scenarios/db-failure/inject.sh).
- **Reset** everything back to v1 / fast / 0% errors and remove the NetworkPolicy.
- **Trigger Agent Fix** posts a synthetic incident to rca-agent via A2A
  and shows the resulting remediation (policy allow/deny, rollout, etc.)
  in a scrolling activity feed.

## Run

```bash
make demo-control
make port-forwards
open http://localhost:15000
```

## Architecture

- **Backend**: `server.js` (Node 20 + Express + @kubernetes/client-node).
  - Reads the 3 deployments via the in-cluster k8s API using the `demo-control`
    ServiceAccount (namespace-scoped to `apps-demo`).
  - Patches deployment env vars for the regression inject.
  - Creates/deletes a `block-db` NetworkPolicy for the DB-failure inject.
  - POSTs an A2A JSON-RPC message to `kagent-controller.kagent:8083/api/a2a/agent-read/rca-agent/`.
  - Tails the 3 agent pod logs in the background via `kubectl logs -f` and
    pushes interesting lines (tool calls, sub-tasks) into an in-memory event ring.
- **Frontend**: vanilla HTML/JS/CSS, polls `/api/state` every 2s. No build step.

## Files

```
apps/demo-control/
├── Dockerfile
├── package.json
├── server.js
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── k8s/
│   ├── rbac.yaml          # ServiceAccount + Role + RoleBinding (apps-demo only)
│   └── deployment.yaml    # Deployment + Service
└── README.md
```
