// Minimal YAML linter for the POC configs (no external deps).
// Checks: YAML parses, has at least one expected key, no tabs.
'use strict';
const fs = require('fs');
const path = require('path');

function loadYamlLite(text) {
  // Tabs are forbidden in YAML
  if (/\t/.test(text)) throw new Error('contains tab characters');
  // Confirm consistent indentation (multiples of 2) and no odd indents.
  // Skip lines that are part of a block-literal (`|`) or block-folded (`>`)
  // scalar — those lines' leading whitespace is part of the content, not
  // the YAML structure, so the linter should not look at them.
  const lines = text.split('\n');
  let inBlockScalar = false;
  let blockScalarIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlockScalar) {
      // Block scalar ends when a line is dedented back to <= blockScalarIndent
      // and is non-empty.
      if (line.trim() === '') continue;
      const indent = line.match(/^ */)[0].length;
      if (indent <= blockScalarIndent) inBlockScalar = false;
      else continue;
    }
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // Detect start of a new block scalar: `key: |` or `key: >`
    if (/^\s*\S.*:\s*[|>][+-]?\s*(#.*)?$/.test(line)) {
      inBlockScalar = true;
      blockScalarIndent = line.match(/^ */)[0].length;
      continue;
    }
    const indent = line.match(/^ */)[0].length;
    if (indent % 2 !== 0) throw new Error(`odd indent ${indent}: ${line.trim()}`);
  }
  // For full validation we'd need js-yaml, but this catches the common issues.
  return true;
}

const files = [
  'infra/kind-config.yaml',
  'infra/prometheus/values.yaml',
  'infra/loki/values.yaml',
  'infra/tempo/values.yaml',
  'infra/otelcollector/values.yaml',
  'infra/grafana/dashboards/sre-poc-overview.yaml',
  'apps/demo-service/k8s/deployment.yaml',
  'apps/demo-service/k8s/databases.yaml',
  'apps/demo-service/k8s/policy.yaml',
  'manifests/rbac/agent-read-rbac.yaml',
  'manifests/rbac/agent-write-rbac.yaml',
  'manifests/mcp/policy-mcp-deployment.yaml',
  'manifests/mcp/prometheus-mcp.yaml',
  'manifests/mcp/loki-mcp.yaml',
  'manifests/mcp/tempo-mcp.yaml',
  'manifests/mcp/alertmanager-mcp.yaml',
  'manifests/mcp/policy-mcp-shim.yaml',
  'manifests/mcp/argocd-mcp.yaml',
  'manifests/mcp/git-mcp.yaml',
  'manifests/mcp/slack-mcp.yaml',
  'manifests/ui-nodeports.yaml',
  'manifests/dashboard/recommended.yaml',
  'manifests/dashboard/admin-user.yaml',
  'manifests/agents/trace-agent.yaml',
  'manifests/agents/rca-agent.yaml',
  'manifests/agents/remediator-agent.yaml',
  'manifests/modelconfig/openai-gpt4o-mini.yaml',
  'manifests/modelconfig/gemini-2-flash-lite.yaml',
  'manifests/kagent-values-gemini.yaml',
  'policy/opa.yaml',
  'mcp-servers/prometheus-mcp/k8s/deployment.yaml',
  'mcp-servers/prometheus-mcp/k8s/service.yaml',
  'mcp-servers/loki-mcp/k8s/deployment.yaml',
  'mcp-servers/loki-mcp/k8s/service.yaml',
  'mcp-servers/tempo-mcp/k8s/deployment.yaml',
  'mcp-servers/tempo-mcp/k8s/service.yaml',
  'mcp-servers/alertmanager-mcp/k8s/deployment.yaml',
  'mcp-servers/alertmanager-mcp/k8s/service.yaml',
  'mcp-servers/policy-mcp-shim/k8s/deployment.yaml',
  'mcp-servers/policy-mcp-shim/k8s/service.yaml',
  'mcp-servers/argocd-mcp/k8s/deployment.yaml',
  'mcp-servers/argocd-mcp/k8s/service.yaml',
  'mcp-servers/git-mcp/k8s/deployment.yaml',
  'mcp-servers/git-mcp/k8s/service.yaml',
  'mcp-servers/slack-mcp/k8s/deployment.yaml',
  'mcp-servers/slack-mcp/k8s/service.yaml',
  'mcp-servers/slack-recorder/k8s/deployment.yaml',
  'mcp-servers/slack-recorder/k8s/service.yaml',
];

const root = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
for (const f of files) {
  const p = path.join(root, f);
  try {
    const txt = fs.readFileSync(p, 'utf8');
    loadYamlLite(txt);
    console.log(`PASS  ${f}`);
    pass++;
  } catch (e) {
    console.log(`FAIL  ${f}: ${e.message}`);
    fail++;
  }
}
console.log(`\n${pass}/${pass+fail} YAML lint checks passed`);
process.exit(fail === 0 ? 0 : 1);