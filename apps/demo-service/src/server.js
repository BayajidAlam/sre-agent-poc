'use strict';
const express = require('express');
const { Client: PgClient } = require('pg');
const { createClient } = require('redis');

const PORT = parseInt(process.env.PORT || '8080', 10);
const APP_VERSION = process.env.APP_VERSION || 'dev';
const PAYMENT_HOST = process.env.PAYMENT_HOST || 'payment.apps-demo.svc.cluster.local';
const INVENTORY_HOST = process.env.INVENTORY_HOST || 'inventory.apps-demo.svc.cluster.local';
const POSTGRES_URL = process.env.POSTGRES_URL || 'postgres://demo:demo@postgres.apps-demo.svc.cluster.local:5432/demo';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis.apps-demo.svc.cluster.local:6379';

// Latency injection — Scenario A (regression) sets this to "slow" via env.
const LATENCY_PROFILE = process.env.LATENCY_PROFILE || 'fast';   // fast | slow | broken
const ERROR_RATE      = parseFloat(process.env.ERROR_RATE || '0'); // 0..1

// ---- DB / cache clients (lazy connect) ------------------------------------
let pg = null, redis = null;
async function getPg() {
  if (pg) return pg;
  pg = new PgClient({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 1500 });
  await pg.connect().catch(() => null); // soft-fail; endpoints will surface errors
  return pg;
}
async function getRedis() {
  if (redis) return redis;
  redis = createClient({ url: REDIS_URL, socket: { connectTimeout: 1500 } });
  redis.on('error', () => {}); // swallow noisy logs
  await redis.connect().catch(() => null);
  return redis;
}

// ---- Helpers ---------------------------------------------------------------
function maybeFail(res) {
  if (Math.random() < ERROR_RATE) {
    res.status(500).json({ error: 'injected_error', version: APP_VERSION });
    return true;
  }
  return false;
}
function latencyDelay() {
  if (LATENCY_PROFILE === 'slow')   return new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
  if (LATENCY_PROFILE === 'broken') return new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
  return new Promise(r => setTimeout(r, 20 + Math.random() * 30));
}

const app = express();
app.use(express.json());

// Health
app.get('/healthz', (_, res) => res.json({ status: 'ok', version: APP_VERSION, profile: LATENCY_PROFILE }));
app.get('/version', (_, res) => res.json({ version: APP_VERSION }));

// Service A: checkout fans out to payment + inventory
app.get('/api/checkout', async (req, res) => {
  if (maybeFail(res)) return;
  await latencyDelay();
  // In-process fan-out (avoids cross-pod HTTP for the POC)
  const payment = await fakePayment();
  const inventory = await fakeInventory();
  const status = (payment.ok && inventory.ok) ? 200 : 500;
  res.status(status).json({
    service: 'checkout',
    version: APP_VERSION,
    payment,
    inventory,
  });
});

// Service B: payment (talks to Postgres)
app.get('/api/payment', async (req, res) => {
  if (maybeFail(res)) return;
  await latencyDelay();
  try {
    const client = await getPg();
    if (!client || !client._connected) throw new Error('pg_unavailable');
    await client.query('SELECT 1');
    res.json({ service: 'payment', version: APP_VERSION, ok: true, db: 'postgres' });
  } catch (e) {
    res.status(500).json({ service: 'payment', version: APP_VERSION, ok: false, error: String(e.message || e) });
  }
});

// Service C: inventory (talks to Redis)
app.get('/api/inventory', async (req, res) => {
  if (maybeFail(res)) return;
  await latencyDelay();
  try {
    const r = await getRedis();
    if (!r || !r.isOpen) throw new Error('redis_unavailable');
    await r.set('demo:ping', Date.now().toString());
    const v = await r.get('demo:ping');
    res.json({ service: 'inventory', version: APP_VERSION, ok: true, db: 'redis', ping: v });
  } catch (e) {
    res.status(500).json({ service: 'inventory', version: APP_VERSION, ok: false, error: String(e.message || e) });
  }
});

// In-process helpers (so checkout doesn't need cross-pod HTTP in the POC)
async function fakePayment() {
  try {
    const client = await getPg();
    if (!client || !client._connected) return { ok: false, error: 'pg_unavailable' };
    await client.query('SELECT 1');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function fakeInventory() {
  try {
    const r = await getRedis();
    if (!r || !r.isOpen) return { ok: false, error: 'redis_unavailable' };
    await r.set('demo:checkout', '1');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    msg: 'demo-service up', version: APP_VERSION, port: PORT,
    profile: LATENCY_PROFILE, error_rate: ERROR_RATE,
  }));
});