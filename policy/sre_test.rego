# OPA tests for sre.rego
package sre.remediation

# ---- ALLOW cases -----------------------------------------------------------
test_allow_undo_payment {
    allow with input as {
        "tool": "kubectl",
        "op": "rollout.undo",
        "target_namespace": "apps-demo",
        "target_resource": "deployment/payment",
        "confidence": 0.9,
        "risk": "medium"
    }
}

test_allow_scale_in_apps_demo {
    allow with input as {
        "tool": "kubectl",
        "op": "scale",
        "target_namespace": "apps-demo",
        "target_resource": "deployment/payment",
        "confidence": 0.75,
        "risk": "low"
    }
}

# ---- DENY: low confidence --------------------------------------------------
test_deny_low_confidence {
    not allow with input as {
        "tool": "kubectl",
        "op": "rollout.undo",
        "target_namespace": "apps-demo",
        "confidence": 0.4,
        "risk": "medium"
    }
}

# ---- DENY: high risk -------------------------------------------------------
test_deny_high_risk {
    not allow with input as {
        "tool": "kubectl",
        "op": "patch",
        "target_namespace": "apps-demo",
        "confidence": 0.9,
        "risk": "high"
    }
}

# ---- DENY: cluster-scoped delete ------------------------------------------
test_deny_cluster_scoped_delete {
    not allow with input as {
        "tool": "kubectl",
        "op": "delete",
        "target_namespace": "ok",
        "target_resource": "node/foo",
        "confidence": 0.99,
        "risk": "low"
    }
}

# ---- DENY: forbidden namespace --------------------------------------------
test_deny_namespace_not_allowed {
    not allow with input as {
        "tool": "kubectl",
        "op": "rollout.undo",
        "target_namespace": "kube-system",
        "confidence": 0.95,
        "risk": "medium"
    }
}

# ---- DENY: empty namespace ------------------------------------------------
test_deny_empty_namespace {
    not allow with input as {
        "tool": "kubectl",
        "op": "scale",
        "target_namespace": "",
        "confidence": 0.95,
        "risk": "low"
    }
}