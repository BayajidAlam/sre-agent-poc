// Spin up the policy-mcp, hit it with allow + deny cases, then exit.
'use strict';
const { spawn } = require('child_process');
const http = require('http');

function postJSON(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: 18080, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 3000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

(async () => {
  // Stub OPA via env (we use a tiny inline OPA stub so we don't need a real OPA pod)
  const stubOpa = `
    const http = require('http');
    const s = http.createServer((req, res) => {
      let buf = '';
      req.on('data', c => buf += c);
      req.on('end', () => {
        const body = JSON.parse(buf || '{}');
        // Mirror the rules in policy/sre.rego (minimal logic)
        const a = body.input || {};
        const nsOk = ['apps-demo', 'agent-write'].includes(a.target_namespace);
        const allow = (a.confidence >= 0.7) && a.risk !== 'high' && nsOk && !(a.tool==='kubectl' && a.op==='delete' && a.target_namespace==='ok');
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ result: allow }));
      });
    });
    s.listen(18181, () => console.log('stub-opa on 18181'));
  `;

  // Write stub to a temp file (use OS-agnostic temp dir)
  const os = require('os');
  const path = require('path');
  const stubPath = path.join(os.tmpdir(), '_stub-opa.js');
  require('fs').writeFileSync(stubPath, stubOpa);

  const opa = spawn('node', [stubPath], { stdio: 'inherit' });
  const mcp = spawn('node', ['-e', `
    process.env.OPA_URL = 'http://127.0.0.1:18181';
    process.env.PORT = '18080';
    process.env.POLICY_TIMEOUT_MS = '2000';
    require('./server.js');
  `], { stdio: 'inherit', cwd: __dirname + '/..' });

  // Wait for servers to come up
  await new Promise(r => setTimeout(r, 800));

  const cases = [
    { name: 'undo payment (allow)', expect: true,
      action: { tool: 'kubectl', op: 'rollout.undo', target_namespace: 'apps-demo', confidence: 0.9, risk: 'medium' } },
    { name: 'low conf (deny)',      expect: false,
      action: { tool: 'kubectl', op: 'rollout.undo', target_namespace: 'apps-demo', confidence: 0.4, risk: 'medium' } },
    { name: 'cluster-scoped del (deny)', expect: false,
      action: { tool: 'kubectl', op: 'delete', target_namespace: 'ok', confidence: 0.99, risk: 'low' } },
    { name: 'bad ns (deny)',        expect: false,
      action: { tool: 'kubectl', op: 'rollout.undo', target_namespace: 'kube-system', confidence: 0.9, risk: 'medium' } },
  ];

  let pass = 0, fail = 0;
  for (const c of cases) {
    try {
      const r = await postJSON('/tools/policy_evaluate', c.action);
      const ok = r.body.allow === c.expect;
      if (ok) { console.log(`PASS  ${c.name} (allow=${r.body.allow})`); pass++; }
      else    { console.log(`FAIL  ${c.name} got allow=${r.body.allow} expected ${c.expect} body=${JSON.stringify(r.body)}`); fail++; }
    } catch (e) {
      console.log(`FAIL  ${c.name} error=${e.message}`); fail++;
    }
  }

  console.log(`\n${pass}/${pass+fail} policy-mcp smoke tests passed`);

  opa.kill(); mcp.kill();
  process.exit(fail === 0 ? 0 : 1);
})();