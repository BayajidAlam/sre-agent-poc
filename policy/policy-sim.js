// Minimal pure-JS port of policy/sre.rego for fast feedback during the POC.
// Mirrors the rules exactly; if you change sre.rego, mirror the change here.
const ALLOWED_NS = new Set(['apps-demo', 'agent-write']);

function clusterScopedDelete(a) {
  return a.tool === 'kubectl' && a.op === 'delete' && a.target_namespace === 'ok';
}

function evaluate(input) {
  const reasons = [];
  if (input.confidence < 0.7) reasons.push(`confidence ${input.confidence} below threshold 0.7`);
  if (input.risk === 'high') reasons.push(`risk=${input.risk} blocks auto-remediation`);
  if (clusterScopedDelete(input)) reasons.push('cluster-scoped kubectl delete is forbidden');
  if (!ALLOWED_NS.has(input.target_namespace)) reasons.push(`namespace "${input.target_namespace}" is not in the allow-list`);
  return {
    allow: reasons.length === 0,
    deny_reasons: reasons,
  };
}

const cases = [
  // ALLOW cases
  { name: 'undo payment (high conf)', expect: true,
    input: { tool: 'kubectl', op: 'rollout.undo', target_namespace: 'apps-demo',
             target_resource: 'deployment/payment', confidence: 0.9, risk: 'medium' } },
  { name: 'scale in apps-demo',      expect: true,
    input: { tool: 'kubectl', op: 'scale',        target_namespace: 'apps-demo',
             target_resource: 'deployment/payment', confidence: 0.75, risk: 'low' } },

  // DENY cases
  { name: 'low confidence',          expect: false,
    input: { tool: 'kubectl', op: 'rollout.undo', target_namespace: 'apps-demo',
             confidence: 0.4, risk: 'medium' } },
  { name: 'high risk',               expect: false,
    input: { tool: 'kubectl', op: 'patch',        target_namespace: 'apps-demo',
             confidence: 0.9, risk: 'high' } },
  { name: 'cluster-scoped delete',   expect: false,
    input: { tool: 'kubectl', op: 'delete',       target_namespace: 'ok',
             target_resource: 'node/foo', confidence: 0.99, risk: 'low' } },
  { name: 'forbidden ns kube-system',expect: false,
    input: { tool: 'kubectl', op: 'rollout.undo', target_namespace: 'kube-system',
             confidence: 0.95, risk: 'medium' } },
  { name: 'empty ns',                expect: false,
    input: { tool: 'kubectl', op: 'scale',        target_namespace: '',
             confidence: 0.95, risk: 'low' } },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = evaluate(c.input).allow;
  if (got === c.expect) {
    console.log(`PASS  ${c.name}`);
    pass++;
  } else {
    console.log(`FAIL  ${c.name} — got allow=${got}, expected ${c.expect}`);
    console.log('      reasons:', evaluate(c.input).deny_reasons);
    fail++;
  }
}
console.log(`\n${pass}/${pass+fail} policy tests passed`);
process.exit(fail === 0 ? 0 : 1);