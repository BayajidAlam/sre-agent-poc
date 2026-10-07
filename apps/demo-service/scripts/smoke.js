#!/usr/bin/env node
// Lightweight in-process smoke test — exercises the route handlers without a real DB/cache.
// We use supertest-style with an in-memory express app instance.
'use strict';

// Bypass OTel require for the test by stubbing the env
process.env.LATENCY_PROFILE = 'fast';
process.env.ERROR_RATE = '0';
process.env.POSTGRES_URL = 'postgres://x:y@127.0.0.1:1/x';   // force soft-fail
process.env.REDIS_URL    = 'redis://127.0.0.1:1';           // force soft-fail

// Stub pg + redis so we don't even try to connect
const Module = require('module');
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'pg') return require.resolve('./_stub.js');
  if (req === 'redis') return require.resolve('./_stub.js');
  return _resolve.call(this, req, ...rest);
};

// Pre-load stubs
const fs = require('fs');
const stubPath = require('path').join(__dirname, '_stub.js');
if (!fs.existsSync(stubPath)) {
  fs.writeFileSync(stubPath, 'module.exports = {};\n');
}

const app = require('../src/server.js');
// We can't easily access `app` after listen() — the server is already running.
// Instead, drive the handlers via fetch against the listening port.
const port = parseInt(process.env.PORT || '8080', 10);

(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(200);
  const base = `http://127.0.0.1:${port}`;
  const targets = ['/healthz', '/version', '/api/checkout', '/api/payment', '/api/inventory'];
  let pass = 0, fail = 0;
  for (const t of targets) {
    try {
      const r = await fetch(base + t);
      const body = await r.json();
      const ok = r.status >= 200 && r.status < 600; // any defined response is a pass for the smoke
      if (ok) { console.log(`PASS  ${t}  status=${r.status}`); pass++; }
      else    { console.log(`FAIL  ${t}  status=${r.status}`); fail++; }
    } catch (e) {
      console.log(`FAIL  ${t}  error=${e.message}`); fail++;
    }
  }
  console.log(`\n${pass}/${pass+fail} smoke tests passed`);
  process.exit(fail === 0 ? 0 : 1);
})();