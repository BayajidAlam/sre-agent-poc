// Validate all 3 A2A JSON schemas against fixture payloads using ajv.
// Run: npm test  (or: node tests/schemas/validate.test.js)
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMAS = ['incident-context', 'rca-finding', 'remediation-action'];

function loadSchema(name) {
  const p = path.join(__dirname, '..', '..', 'schemas', `${name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = {};
for (const name of SCHEMAS) {
  validators[name] = ajv.compile(loadSchema(name));
}

// ---- Fixtures (intentionally minimal but valid) ---------------------------
const validIncident = {
  incident_id: 'inc-001',
  service: 'checkout',
  namespace: 'apps-demo',
  window_start: '2026-10-04T12:00:00Z',
  window_end:   '2026-10-04T12:05:00Z',
  severity: 'error',
  traces: [
    { trace_id: 'abc123', root_service: 'checkout', status: 'error', http_status: 500, duration_ms: 1234.5 }
  ],
  logs: [
    { timestamp: '2026-10-04T12:01:00Z', service: 'payment', level: 'error', message: 'connect ETIMEDOUT postgres:5432', trace_id: 'abc123' }
  ],
  metrics: [
    { name: 'http_requests_total', labels: { code: '500', service: 'checkout' }, value: 42 }
  ]
};

const validRCA = {
  incident_id: 'inc-001',
  probable_cause: 'Payment service returning 500s after v2 rollout',
  evidence: [
    { source: 'argocd', ref: 'app=payment rev=v2', note: 'Deployed 3m before error spike' },
    { source: 'tempo',  ref: 'abc123', note: 'failing trace' }
  ],
  risk: 'medium',
  confidence: 0.9,
  proposed_action: {
    tool: 'kubectl',
    op: 'rollout.undo',
    target_namespace: 'apps-demo',
    target_resource: 'deployment/payment'
  }
};

const validAction = {
  action_id: 'act-9c3',
  incident_id: 'inc-001',
  tool: 'kubectl',
  op: 'rollout.undo',
  target_namespace: 'apps-demo',
  target_resource: 'deployment/payment',
  risk: 'medium',
  confidence: 0.9,
  requested_by: 'rca-agent@v1',
  created_at: '2026-10-04T12:06:00Z',
  policy_decision: { allow: true, reason: 'all rules pass', decided_at: '2026-10-04T12:06:01Z' }
};

// ---- Negative fixtures -----------------------------------------------------
const badIncident = { ...validIncident, severity: 'catastrophe' };       // enum violation
const badRCA      = { ...validRCA,      confidence: 1.5 };              // > 1
const badAction   = { ...validAction,   op: 'delete', target_namespace: 'kube-system' }; // allowed syntactically, but OPA would deny

// ---- Run -------------------------------------------------------------------
const cases = [
  { name: 'incident-context / valid',     schema: 'incident-context', data: validIncident, expect: true  },
  { name: 'incident-context / invalid',   schema: 'incident-context', data: badIncident,   expect: false },
  { name: 'rca-finding / valid',          schema: 'rca-finding',      data: validRCA,      expect: true  },
  { name: 'rca-finding / invalid',        schema: 'rca-finding',      data: badRCA,        expect: false },
  { name: 'remediation-action / valid',   schema: 'remediation-action',data: validAction,   expect: true  },
  { name: 'remediation-action / risky',   schema: 'remediation-action',data: badAction,     expect: true  } // syntactically valid; OPA layer enforces safety
];

let pass = 0, fail = 0;
for (const c of cases) {
  const ok = validators[c.schema](c.data);
  const got = !!ok;
  if (got === c.expect) { console.log(`PASS  ${c.name}`); pass++; }
  else {
    console.log(`FAIL  ${c.name}`);
    console.log('      errors:', JSON.stringify(validators[c.schema].errors, null, 2));
    fail++;
  }
}
console.log(`\n${pass}/${pass+fail} schema tests passed`);
process.exit(fail === 0 ? 0 : 1);