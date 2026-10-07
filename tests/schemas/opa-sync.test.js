// Verifies the OPA policy bundled in policy/opa.yaml matches policy/sre.rego.
// If you edit sre.rego, mirror the change into policy/opa.yaml (the bundled copy).
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const standalone = fs.readFileSync(path.join(root, 'policy', 'sre.rego'), 'utf8');
const bundled    = fs.readFileSync(path.join(root, 'policy', 'opa.yaml'), 'utf8');

// Extract just the policy body from the YAML by looking for the sre.rego key.
// The body in YAML is indented by 10 spaces (under ConfigMap.data.<key>:).
// We strip those 10 spaces. Use [\s\S] so the regex matches across blank lines
// until we hit a line that's NOT indented (i.e. the next YAML key).
const m = bundled.match(/sre\.rego:\s*\|\s*\n((?:[ \t]+[\s\S]*?\n)(?=\S))/);
if (!m) { console.log('FAIL  could not find sre.rego block in opa.yaml'); process.exit(1); }
const yamlBody = m[1].replace(/^ {10}/gm, '');

// Compare key snippets that drive behavior
const checks = [
  'default allow = false',
  'allowed_namespaces :=',
  'cluster_scoped_delete',
  'input.confidence >= 0.7',
  'input.risk != "high"',
  'namespace_allowed(input.target_namespace)',
];

let pass = 0, fail = 0;
for (const c of checks) {
  const inSrc = standalone.includes(c);
  const inYml = yamlBody.includes(c);
  if (inSrc && inYml) { console.log(`PASS  ${c}`); pass++; }
  else { console.log(`FAIL  ${c} — src=${inSrc} yaml=${inYml}`); fail++; }
}
console.log(`\n${pass}/${pass+fail} policy-sync checks passed`);
process.exit(fail === 0 ? 0 : 1);