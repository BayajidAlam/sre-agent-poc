// demo-control frontend — vanilla JS, polls /api/state every 2s, no deps.

const POLL_MS = 2000;
const state = {
  services: [],
  network_policy_block_db: false,
  task: { status: 'idle' },
  events: [],
  prevVersions: {}, // for flash on change
};

const $ = (id) => document.getElementById(id);

function fmtTime(iso) {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  return d.toTimeString().slice(0, 8);
}

function pillForService(s) {
  if (s.version !== 'v1' || s.profile !== 'fast' || parseFloat(s.error_rate) > 0) {
    return '<span class="pill pill-yellow">degraded</span>';
  }
  return '<span class="pill pill-green">healthy</span>';
}

function pillForTask(t) {
  if (!t || t.status === 'idle') return { cls: 'pill-grey', text: 'task: idle', title: 'current agent task' };
  if (t.status === 'running') return { cls: 'pill-blue', text: 'task: running', title: 'current agent task' };
  if (t.status === 'completed') return { cls: 'pill-green', text: 'task: done', title: 'current agent task' };
  if (t.status === 'failed') return { cls: 'pill-red', text: 'task: failed', title: 'current agent task' };
  return { cls: '', text: `task: ${t.status}`, title: 'current agent task' };
}

function pillForNetpolicy(np) {
  if (np) return { cls: 'pill-red', text: 'np: block-db active', title: 'NetworkPolicy block-db is active — apps cannot reach postgres/redis' };
  return { cls: 'pill-grey', text: 'np: clear', title: 'no NetworkPolicy block-db' };
}

function applyPill(el, p) {
  el.className = 'pill ' + p.cls;
  el.textContent = p.text;
  el.title = p.title || '';
}

function renderServices() {
  const tbody = document.querySelector('#services tbody');
  if (!state.services.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted center">no services</td></tr>';
    return;
  }
  tbody.innerHTML = state.services.map(s => {
    const verClass = s.version === 'v1' ? 'version-v1' : (s.version === 'v2' ? 'version-v2' : 'version-other');
    const flash = state.prevVersions[s.service] && state.prevVersions[s.service] !== s.version ? 'flash' : '';
    state.prevVersions[s.service] = s.version;
    return `<tr class="${flash}">
      <td><b>${s.service}</b></td>
      <td>${pillForService(s)}</td>
      <td class="mono ${verClass}">${s.version}</td>
      <td class="mono">${s.profile}</td>
      <td class="mono">${(parseFloat(s.error_rate) * 100).toFixed(0)}%</td>
      <td class="mono">${s.replicas}</td>
      <td class="mono small muted">${s.image}</td>
    </tr>`;
  }).join('');
}

function renderEvents() {
  const list = $('events');
  const seen = new Set();
  // Render newest events on top (reverse chronological order).
  list.innerHTML = state.events.slice().reverse().map(e => {
    const key = e.t + e.agent + e.message;
    if (seen.has(key)) return '';
    seen.add(key);
    const lvl = e.level || 'info';
    return `<li>
      <span class="ts">${fmtTime(e.t)}</span>
      <span class="lvl ${lvl}">${lvl}</span>
      <span class="agent ${e.agent}">${e.agent}</span>
      <span class="msg">${escapeHtml(e.message)}</span>
    </li>`;
  }).join('');
  // No auto-scroll — newest is already at the top.
  list.scrollTop = 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderTaskSummary() {
  const t = state.task || { status: 'idle' };
  const el = $('task-summary');
  el.className = 'task-summary ' + (t.status || 'idle');
  if (t.status === 'idle' || !t.status) {
    el.textContent = 'No agent task in flight.';
  } else {
    const dur = (t.startedAt && (t.finishedAt || new Date().toISOString())) ?
      Math.round((new Date(t.finishedAt || new Date().toISOString()) - new Date(t.startedAt)) / 1000) + 's' : '';
    el.textContent = `[${t.status}] ${t.kind || ''} ${t.summary || ''}  ${dur}  (started ${fmtTime(t.startedAt)})`;
  }
}

function renderHeader() {
  applyPill($('netpolicy-pill'), pillForNetpolicy(state.network_policy_block_db));
  applyPill($('task-pill'), pillForTask(state.task));
  $('last-poll').textContent = 'last poll: ' + fmtTime(new Date().toISOString());
}

async function poll() {
  try {
    const resp = await fetch('/api/state');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    state.services = data.services || [];
    state.network_policy_block_db = !!data.network_policy_block_db;
    state.task = data.task || { status: 'idle' };
    state.events = data.events || [];
    renderServices();
    renderEvents();
    renderTaskSummary();
    renderHeader();
  } catch (e) {
    console.error('poll failed', e);
    $('last-poll').textContent = 'last poll failed: ' + e.message;
  }
}

async function post(path) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) {
      const t = await r.text();
      console.error('POST ' + path + ' failed', r.status, t);
      alert('POST ' + path + ' failed: ' + r.status + ' ' + t.slice(0, 200));
    }
  } catch (e) {
    console.error('POST ' + path + ' threw', e);
    alert('POST ' + path + ' threw: ' + e.message);
  }
  // Poll fast for the next ~10s so the user sees the agent work live, then
  // fall back to the regular 2s cadence.
  poll();
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    poll();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Inject buttons chain into the agent fix automatically; the "Trigger Agent
  // Fix (no inject)" button is the manual override.
  $('btn-inject-regression').onclick = () => post('/api/inject/regression?fix=1');
  $('btn-inject-db').onclick        = () => post('/api/inject/db-failure?fix=1');
  $('btn-fix').onclick               = () => post('/api/fix');
  $('btn-reset').onclick             = () => post('/api/reset');
  $('btn-clear-logs').onclick        = () => post('/api/clear');
  poll();
  setInterval(poll, POLL_MS);
});
