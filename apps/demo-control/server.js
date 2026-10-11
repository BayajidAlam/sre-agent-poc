/*
 * demo-control/server.js
 *
 * A small Express + @kubernetes/client-node app that:
 *   1. Reads the live state of the 3 demo services (checkout, payment, inventory)
 *      in the apps-demo namespace (APP_VERSION, LATENCY_PROFILE, ERROR_RATE, replicas).
 *   2. Injects the same env changes as scenarios/regression/inject.sh
 *      and scenarios/db-failure/inject.sh.
 *   3. Triggers the agent pipeline by POSTing a synthetic IncidentContext
 *      to kagent-controller's A2A endpoint.
 *   4. Captures the A2A response and the agent pod log tail, exposing a
 *      ring buffer of events the frontend can poll.
 *
 * In-cluster, uses the mounted ServiceAccount token via @kubernetes/client-node's
 * inCluster helper. Talks to kagent-controller over the cluster's internal DNS.
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const k8s = require('@kubernetes/client-node');

const PORT = parseInt(process.env.PORT || '8080', 10);
const NS = process.env.NS || 'apps-demo';
const KAGENT_NS = process.env.KAGENT_NS || 'kagent';
const KAGENT_AGENT_NS = process.env.KAGENT_AGENT_NS || 'agent-read';
const KAGENT_CONTROLLER_URL = process.env.KAGENT_CONTROLLER_URL
  || `http://kagent-controller.${KAGENT_NS}.svc.cluster.local:8083`;
const ROLLOUT_TIMEOUT_MS = 90_000;
const EVENT_BUFFER_SIZE = 100;
const SERVICES = ['checkout', 'payment', 'inventory'];

// --- Kubernetes client -------------------------------------------------------
const kc = new k8s.KubeConfig();
if (process.env.KUBERNETES_SERVICE_HOST) {
  kc.loadFromCluster();
} else {
  kc.loadFromDefault();
}
const appsApi = kc.makeApiClient(k8s.AppsV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);

// --- Event ring buffer -------------------------------------------------------
const events = [];
let currentTask = { status: 'idle', startedAt: null, finishedAt: null, kind: null, summary: null };
function pushEvent(level, agent, message) {
  const ev = {
    t: new Date().toISOString(),
    level,            // 'info' | 'ok' | 'warn' | 'err'
    agent,            // 'user' | 'rca-agent' | 'remediator-agent' | 'trace-agent' | 'system' | 'policy'
    message,
  };
  events.push(ev);
  if (events.length > EVENT_BUFFER_SIZE) events.splice(0, events.length - EVENT_BUFFER_SIZE);
}
function setTask(status, kind, summary) {
  currentTask = {
    status,
    startedAt: status === 'running' ? new Date().toISOString() : currentTask.startedAt,
    finishedAt: status === 'completed' || status === 'failed' ? new Date().toISOString() : currentTask.finishedAt,
    kind: kind || currentTask.kind,
    summary: summary || currentTask.summary,
  };
}

// --- Helpers -----------------------------------------------------------------
async function getServiceState(name) {
  const dep = await appsApi.readNamespacedDeployment(name, NS);
  const containers = dep.body.spec.template.spec.containers;
  const env = (containers[0].env || []);
  const envMap = Object.fromEntries(env.map(e => [e.name, e.value]));
  const replicas = dep.body.spec.replicas || 0;
  const ready = dep.body.status.readyReplicas || 0;
  return {
    service: name,
    version: envMap.APP_VERSION || '?',
    profile: envMap.LATENCY_PROFILE || '?',
    error_rate: parseFloat(envMap.ERROR_RATE || '0'),
    replicas: `${ready}/${replicas}`,
    image: containers[0].image,
  };
}

async function patchServiceEnv(name, envPatch) {
  // fetch current
  const dep = await appsApi.readNamespacedDeployment(name, NS);
  const containers = dep.body.spec.template.spec.containers;
  const env = (containers[0].env || []).filter(e => !(e.name in envPatch));
  Object.assign(containers[0], { env: [...env, ...Object.entries(envPatch).map(([k, v]) => ({ name: k, value: String(v) }))] });
  await appsApi.replaceNamespacedDeployment(name, NS, dep.body);
  // wait for rollout
  const start = Date.now();
  while (Date.now() - start < ROLLOUT_TIMEOUT_MS) {
    const d2 = await appsApi.readNamespacedDeployment(name, NS);
    const status = d2.body.status;
    if (status.updatedReplicas === status.replicas && status.readyReplicas === status.replicas && status.availableReplicas === status.replicas) {
      return;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`rollout of ${name} did not complete in ${ROLLOUT_TIMEOUT_MS}ms`);
}

async function applyNetworkPolicy() {
  const yaml = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'block-db', namespace: NS },
    spec: {
      podSelector: { matchLabels: { tier: 'demo' } },
      policyTypes: ['Egress'],
      egress: [{ to: [{ podSelector: {} }], ports: [{ port: 8080 }] }],
    },
  };
  try {
    await networkingApi.createNamespacedNetworkPolicy(NS, yaml);
  } catch (e) {
    if (e.statusCode === 409) {
      // already exists; replace
      await networkingApi.replaceNamespacedNetworkPolicy('block-db', NS, yaml);
    } else {
      throw e;
    }
  }
}

async function deleteNetworkPolicy() {
  try { await networkingApi.deleteNamespacedNetworkPolicy('block-db', NS); } catch (e) { if (e.statusCode !== 404) throw e; }
}

async function networkPolicyPresent() {
  try {
    await networkingApi.readNamespacedNetworkPolicy('block-db', NS);
    return true;
  } catch (e) { return false; }
}

// --- Agent log tailers -------------------------------------------------------
// For each agent pod, tail logs in the background and push interesting lines
// into the event buffer. Started once on boot, never restarted.
let logTailerStarted = false;
let logTailerAttempts = 0;
function startAgentLogTailers() {
  if (logTailerStarted) return;
  if (process.env.DISABLE_LOG_TAIL === '1') return;
  if (logTailerAttempts++ > 2) {
    console.warn('log tailer gave up after 2 attempts; events will only come from explicit A2A responses');
    return;
  }
  // Find the kagent binary on PATH (we're in the kagent-tools image-equivalent
  // container which has kubectl). If not present, skip silently.
  let kubectlBin = 'kubectl';
  if (!fs.existsSync('/usr/local/bin/kubectl') && !fs.existsSync('/usr/bin/kubectl')) {
    console.warn('kubectl not in PATH inside demo-control; skipping log tailers');
    return;
  }
  logTailerStarted = true; // set BEFORE the spawn so even if it crashes we don't retry
  for (const agent of ['trace-agent', 'rca-agent', 'remediator-agent']) {
    const args = [
      'logs', '-n', KAGENT_AGENT_NS, '-l', 'app=kagent',
      '--tail=0', '-f',
    ];
    let child;
    try {
      child = spawn(kubectlBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      console.warn(`could not start log tailer for ${agent}: ${e.message}`);
      continue;
    }
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) summarizeAgentLine(agent, line);
    });
    child.stderr.on('data', (chunk) => {
      // First few lines of stderr from kubectl are harmless config messages;
      // log once and ignore.
      const s = chunk.toString();
      if (s.includes('Unable to connect to the server')) {
        console.warn(`log tailer for ${agent}: cannot reach API server (in-cluster credentials missing?)`);
      }
    });
    child.on('exit', (code) => {
      console.warn(`log tailer for ${agent} exited code=${code}`);
    });
  }
}

const TOOL_RE = /HTTP Request:\s+POST\s+http:\/\/([a-z0-9-]+)-mcp\.agent-read/;
function summarizeAgentLine(agent, line) {
  // skip noisy lines
  if (!line.trim()) return;
  if (line.includes("HTTP Request:") && line.includes("redirect")) return; // 307s
  if (line.includes('Sending out request, model:')) {
    pushEvent('info', agent, `asking LLM`);
    return;
  }
  if (line.includes('Response received from the model')) {
    pushEvent('info', agent, `LLM response received`);
    return;
  }
  if (line.includes('AFC is enabled')) return; // already obvious
  if (line.includes('thought_signature')) return; // internal SDK noise
  const m = line.match(TOOL_RE);
  if (m) {
    pushEvent('info', agent, `calling ${m[1]}-mcp`);
    return;
  }
  if (line.includes('/api/tasks') && line.includes('201')) {
    pushEvent('info', 'system', `${agent} dispatched A2A sub-task`);
    return;
  }
}

// --- A2A trigger -------------------------------------------------------------
// kagent 0.7 rejects A2A peer refs that form cycles (rca-agent ↔
// remediator-agent). The pipeline is therefore driven by the caller: we POST
// the IncidentContext to rca-agent, harvest the RCAFinding, then POST that
// RCAFinding as the user message to remediator-agent. remediator-agent
// builds the RemediationAction, evaluates policy-mcp, and (on allow) writes
// to the cluster.
function buildA2APayload(id, text) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        parts: [{ kind: 'text', text }],
      },
    },
  };
}

function a2aUrl(agentName) {
  return `${KAGENT_CONTROLLER_URL}/api/a2a/${KAGENT_AGENT_NS}/${agentName}/`;
}

function summarizeHistory(body, agentLabel) {
  const history = body?.result?.history || [];
  for (const msg of history) {
    for (const part of (msg.parts || [])) {
      if (part.kind === 'data' && part.metadata?.kagent_type === 'function_call') {
        const d = part.data;
        if (d?.name) pushEvent('info', agentLabel, `tool call: ${d.name}(${JSON.stringify(d.args).slice(0, 80)})`);
      }
      if (part.kind === 'data' && part.metadata?.kagent_type === 'function_response') {
        const d = part.data;
        if (d?.name && d?.response?.result?.isError) {
          pushEvent('warn', agentLabel, `tool ${d.name} returned error: ${(d.response.result.content?.[0]?.text || '').slice(0, 120)}`);
        }
      }
    }
  }
}

// Balanced-brace matcher: find the substring that starts at index `start`
// and ends at the matching closing brace, respecting nested objects/arrays
// and string literals. Returns the substring or null.
function extractBalancedJson(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = false; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function findRcaFinding(body) {
  // The final assistant message is typically the last history entry OR a text
  // artifact. It must contain an object with probable_cause + proposed_action.
  const candidates = [];
  for (const a of (body?.result?.artifacts || [])) {
    for (const p of (a.parts || [])) {
      if (p.kind === 'text' && p.text) candidates.push(p.text);
    }
  }
  for (const m of (body?.result?.history || [])) {
    for (const p of (m.parts || [])) {
      if (p.kind === 'text' && p.text && m.role === 'agent') candidates.push(p.text);
    }
  }
  for (const text of candidates) {
    // 1) Try parsing the whole text as a single JSON object.
    try {
      const j = JSON.parse(text);
      if (j.probable_cause && j.proposed_action) return j;
    } catch {}
    // 2) Search for any object that contains "probable_cause" and use a
    //    balanced-brace matcher so we correctly capture nested objects
    //    (evidence[], params{}, etc.) without truncating at the first }.
    let from = 0;
    while (true) {
      const idx = text.indexOf('"probable_cause"', from);
      if (idx === -1) break;
      // Walk backwards to the opening { of this object.
      let braceStart = -1;
      for (let i = idx; i >= 0; i--) {
        if (text[i] === '{') { braceStart = i; break; }
        if (text[i] === '}' || text[i] === ']') break; // hit a closer first; not our object
      }
      if (braceStart === -1) { from = idx + 1; continue; }
      const slice = extractBalancedJson(text, braceStart);
      from = idx + 1;
      if (!slice) continue;
      try {
        const j = JSON.parse(slice);
        if (j.probable_cause && j.proposed_action) return j;
      } catch {}
    }
  }
  return null;
}

function findRemediationAction(body) {
  for (const a of (body?.result?.artifacts || [])) {
    for (const p of (a.parts || [])) {
      if (p.kind === 'text' && p.text) {
        try {
          const j = JSON.parse(p.text);
          if (j.policy_decision && (j.tool || j.op)) return j;
        } catch {}
        // Balanced-brace search for an object containing "policy_decision".
        let from = 0;
        while (true) {
          const idx = p.text.indexOf('"policy_decision"', from);
          if (idx === -1) break;
          let braceStart = -1;
          for (let i = idx; i >= 0; i--) {
            if (p.text[i] === '{') { braceStart = i; break; }
            if (p.text[i] === '}' || p.text[i] === ']') break;
          }
          from = idx + 1;
          if (braceStart === -1) continue;
          const slice = extractBalancedJson(p.text, braceStart);
          if (!slice) continue;
          try {
            const j = JSON.parse(slice);
            if (j.policy_decision && (j.tool || j.op)) return j;
          } catch {}
        }
      }
    }
  }
  return null;
}

async function postA2A(agentName, id, userText) {
  const url = a2aUrl(agentName);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildA2APayload(id, userText)),
  });
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { body, text, rawSize: text.length };
}

async function triggerAgentFix(service) {
  const incidentId = `ui-${Date.now()}`;
  const now = new Date().toISOString();
  const incident = {
    incident_id: incidentId,
    service,
    severity: 'error',
    window_start: now,
    window_end: now,
  };
  pushEvent('info', 'user', `triggered agent fix for service=${service} (incident=${incidentId})`);
  setTask('running', 'fix', `investigating ${service}`);

  // ---- Step 1: rca-agent produces an RCAFinding ----------------------------
  pushEvent('info', 'rca-agent', `dispatching IncidentContext to rca-agent`);
  let rcaResp;
  try {
    rcaResp = await postA2A('rca-agent', incidentId, JSON.stringify(incident));
  } catch (e) {
    pushEvent('err', 'system', `rca-agent call failed: ${e.message}`);
    setTask('failed', 'fix', `rca-agent unreachable: ${e.message}`);
    return { incidentId };
  }
  summarizeHistory(rcaResp.body, 'rca-agent');
  const rcaFinding = findRcaFinding(rcaResp.body);
  if (!rcaFinding) {
    pushEvent('warn', 'rca-agent', `no RCAFinding parsed from rca-agent response (raw=${rcaResp.rawSize}b)`);
    // Capture any plain text the agent emitted so the user can see what it said.
    for (const a of (rcaResp.body?.result?.artifacts || [])) {
      for (const p of (a.parts || [])) {
        if (p.kind === 'text' && p.text) {
          pushEvent('info', 'rca-agent', `final text: ${p.text.replace(/\n/g, ' ').slice(0, 200)}`);
        }
      }
    }
    setTask('completed', 'fix', 'rca-agent finished (no structured RCAFinding)');
    return { incidentId, body: rcaResp.body };
  }
  pushEvent('ok', 'rca-agent', `RCAFinding: ${rcaFinding.probable_cause} → ${rcaFinding.proposed_action?.tool}.${rcaFinding.proposed_action?.op} ${rcaFinding.proposed_action?.target_resource}`);

  // ---- Step 2: remediator-agent takes the RCAFinding -----------------------
  pushEvent('info', 'remediator-agent', `dispatching RCAFinding to remediator-agent`);
  let remResp;
  try {
    remResp = await postA2A('remediator-agent', `${incidentId}-rem`, JSON.stringify(rcaFinding));
  } catch (e) {
    pushEvent('err', 'system', `remediator-agent call failed: ${e.message}`);
    setTask('failed', 'fix', `remediator-agent unreachable: ${e.message}`);
    return { incidentId };
  }
  summarizeHistory(remResp.body, 'remediator-agent');
  const remediation = findRemediationAction(remResp.body);
  if (remediation) {
    const allow = remediation.policy_decision?.allow;
    const tool = remediation.tool;
    const op = remediation.op;
    const tgt = remediation.target_resource;
    if (allow === true) {
      pushEvent('ok', 'remediator-agent', `policy ALLOW — executed ${tool}.${op} on ${tgt}`);
      setTask('completed', 'fix', `remediation applied: ${tool}.${op} ${tgt}`);
    } else if (allow === false) {
      const reason = remediation.policy_decision?.reason || 'denied';
      pushEvent('warn', 'remediator-agent', `policy DENY (${reason}) — no cluster write performed`);
      setTask('completed', 'fix', `policy denied: ${reason}`);
    } else {
      pushEvent('info', 'remediator-agent', `remediation plan: ${tool}.${op} ${tgt} (risk=${remediation.risk}, conf=${remediation.confidence})`);
      setTask('completed', 'fix', `${tool}.${op} ${tgt}`);
    }
  } else {
    pushEvent('warn', 'remediator-agent', `no structured RemediationAction in remediator response (raw=${remResp.rawSize}b)`);
    for (const a of (remResp.body?.result?.artifacts || [])) {
      for (const p of (a.parts || [])) {
        if (p.kind === 'text' && p.text) {
          pushEvent('info', 'remediator-agent', `final text: ${p.text.replace(/\n/g, ' ').slice(0, 200)}`);
        }
      }
    }
    setTask('completed', 'fix', 'remediator-agent finished (see events)');
  }
  return { incidentId, rcaFinding, remediation };
}

// --- HTTP routes -------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/state', async (_req, res) => {
  try {
    const services = await Promise.all(SERVICES.map(getServiceState));
    const np = await networkPolicyPresent();
    res.json({
      services,
      network_policy_block_db: np,
      task: currentTask,
      events: events.slice(-50),
    });
  } catch (e) {
    console.error('GET /api/state', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/inject/regression', async (req, res) => {
  try {
    pushEvent('info', 'user', 'injected: payment v2 (slow + 50% errors)');
    setTask('idle', null, null);
    await patchServiceEnv('payment', { APP_VERSION: 'v2', LATENCY_PROFILE: 'slow', ERROR_RATE: '0.5' });
    pushEvent('warn', 'system', 'payment is now v2 — error rate 50%, latency ~2s');
    // Optionally chain into the agent fix so a single click runs the full loop:
    //   inject → rca-agent → remediator-agent → policy ALLOW → rollout undo → v1
    if (String(req.query.fix) === '1') {
      // Don't block the HTTP response — kick off the fix in the background.
      triggerAgentFix('payment').catch(e => pushEvent('err', 'system', `auto-fix after inject failed: ${e.message}`));
    }
    res.json({ ok: true });
  } catch (e) {
    pushEvent('err', 'system', `inject regression failed: ${e.message}`);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/inject/db-failure', async (req, res) => {
  try {
    pushEvent('info', 'user', 'injected: NetworkPolicy block-db (breaks postgres+redis egress)');
    setTask('idle', null, null);
    await applyNetworkPolicy();
    pushEvent('warn', 'system', 'NetworkPolicy block-db applied — apps cannot reach postgres/redis');
    // Same auto-fix chain. Expectation: policy-mcp-shim returns allow=false
    // (deleting NetworkPolicy is high-risk per policy/opa.rego) so the agents
    // diagnose but do NOT write.
    if (String(req.query.fix) === '1') {
      triggerAgentFix('payment').catch(e => pushEvent('err', 'system', `auto-fix after inject failed: ${e.message}`));
    }
    res.json({ ok: true });
  } catch (e) {
    pushEvent('err', 'system', `inject db-failure failed: ${e.message}`);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/reset', async (_req, res) => {
  try {
    pushEvent('info', 'user', 'reset: rolling all services back to v1 + removing NetworkPolicy');
    setTask('idle', null, null);
    await Promise.all(SERVICES.map(s => patchServiceEnv(s, { APP_VERSION: 'v1', LATENCY_PROFILE: 'fast', ERROR_RATE: '0' }).catch(e => ({ err: e.message, svc: s }))));
    await deleteNetworkPolicy();
    pushEvent('ok', 'system', 'all services back to v1 / fast / 0% errors; NetworkPolicy removed');
    res.json({ ok: true });
  } catch (e) {
    pushEvent('err', 'system', `reset failed: ${e.message}`);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/fix', async (req, res) => {
  const service = (req.body && req.body.service) || 'payment';
  try {
    const out = await triggerAgentFix(service);
    res.json({ ok: true, incidentId: out.incidentId });
  } catch (e) {
    pushEvent('err', 'system', `agent fix failed: ${e.message}`);
    setTask('failed', 'fix', e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/clear', (_req, res) => {
  // Empty the in-memory event ring buffer (does not touch the cluster).
  // We then push a single marker event so the user has visual confirmation
  // that the clear happened.
  const count = events.length;
  events.length = 0;
  pushEvent('info', 'user', `cleared activity log (removed ${count} previous event${count === 1 ? '' : 's'})`);
  setTask('idle', null, null);
  res.json({ ok: true, cleared: count });
});

// --- Boot --------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`demo-control listening on :${PORT} (ns=${NS} kagent_ns=${KAGENT_NS})`);
  pushEvent('info', 'system', `demo-control ready — watching ${SERVICES.join(', ')} in ${NS}`);
  startAgentLogTailers();
});
