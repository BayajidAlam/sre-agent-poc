# Runbook — payment-regression

If payment error rate > 5% for > 2 min and v2 was deployed in the last hour:

1. Confirm via `kubectl rollout history deployment/payment -n apps-demo`.
2. Roll back: `kubectl rollout undo deployment/payment -n apps-demo`.
3. Verify error rate drops via the SLO dashboard.
4. Notify #ops channel.

If the deployment was a NetworkPolicy / Node / CRD change, halt and page a human.