// Minimal MCP server that wraps OPA's REST API.
// POST /tools/policy_evaluate  body: RemediationAction JSON
//   -> { allow: bool, reason: string, deny_reasons: [string] }
//
// Two safety nets:
//   1. We enforce OPA's timeout (POLICY_TIMEOUT_MS) so a hung OPA doesn't block remediation.
//   2. Default-deny: if OPA returns anything other than {result:true}, we treat it as deny.
'use strict';
const http = require('http');

const OPA_URL = process.env.OPA_URL || 'http://opa.agent-write.svc.cluster.local:8181';
const POLICY_PATH = process.env.OPA_POLICY_PATH || '/v1/data/sre/remediation/allow';
const POLICY_TIMEOUT_MS = parseInt(process.env.POLICY_TIMEOUT_MS || '2000', 10);
const PORT = parseInt(process.env.PORT || '8080', 10);

function callOpa(input) {
  return new Promise((resolve, reject) => {
    const u = new URL(OPA_URL + POLICY_PATH);
    const body = JSON.stringify({ input });
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: POLICY_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) { reject(new Error(`bad OPA response: ${data}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('opa_timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Health probe
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', opa: OPA_URL }));
    return;
  }

  // MCP tool entrypoint
  if (req.method === 'POST' && req.url === '/tools/policy_evaluate') {
    try {
      const action = await readBody(req);
      const opaResp = await callOpa(action);
      const allow = !!opaResp.result;
      const deny_reasons = allow ? [] : ['opa returned result != true'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        allow,
        deny_reasons,
        reason: allow ? 'all rules pass' : (deny_reasons[0] || 'unknown'),
        raw: opaResp,
      }));
    } catch (e) {
      // Default-deny on ANY error
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        allow: false,
        deny_reasons: ['opa_error: ' + (e.message || String(e))],
        reason: 'opa error — default deny',
      }));
    }
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ msg: 'policy-mcp up', port: PORT, opa: OPA_URL, policy_path: POLICY_PATH, timeout_ms: POLICY_TIMEOUT_MS }));
});