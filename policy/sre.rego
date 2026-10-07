# =============================================================================
#  sre.rego — Policy gate for remediator-agent
#
#  Rules (plan §6):
#    allow iff:
#      - confidence >= 0.7
#      - risk != "high"
#      - not a cluster-scoped delete
#      - target_namespace is in the allow-list
#
#  Eval this with:
#    opa eval -d policy/sre.rego -i input.json 'data.sre.remediation.allow'
# =============================================================================
package sre.remediation

default allow = false
default deny_reason = "no reason captured"

# --- Configuration (data, not input) ---------------------------------------
allowed_namespaces := {"apps-demo", "agent-write"}

# Cluster-scoped "safe" sentinel: when kubectl deletes target the cluster,
# the kagent layer requires target_namespace to be the literal string "ok".
cluster_scoped_delete(a) {
    a.tool == "kubectl"
    a.op == "delete"
    a.target_namespace == "ok"
}

namespace_allowed(ns) {
    allowed_namespaces[ns]
}

# --- Decision ---------------------------------------------------------------
allow {
    input.confidence >= 0.7
    input.risk != "high"
    not cluster_scoped_delete(input)
    namespace_allowed(input.target_namespace)
}

# Structured reason for slack messages
deny_reason = msg {
    input.confidence < 0.7
    msg := sprintf("confidence %.2f below threshold 0.7", [input.confidence])
}

deny_reason = msg {
    input.risk == "high"
    msg := sprintf("risk=%s blocks auto-remediation", [input.risk])
}

deny_reason = msg {
    cluster_scoped_delete(input)
    msg := "cluster-scoped kubectl delete is forbidden"
}

deny_reason = msg {
    not namespace_allowed(input.target_namespace)
    msg := sprintf("namespace %q is not in the allow-list", [input.target_namespace])
}