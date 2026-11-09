import { icon as I, mark } from './icons.js';
import { moneyChart, donut, hbars, stacked, histogram, usd as usdC } from './charts.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (c) => `$${(c / 100).toFixed(2)}`;
void 0;
let state = null;
let csrf = '';
let busy = false;
let view = (location.hash || '#overview').slice(1);
let copilotLog = [];
let lastToken = '';
const seen = new Set(); // ids already rendered, so only genuinely new decisions get the stamp animation
let firstRender = true;

document.querySelectorAll('.brandmark').forEach((e) => { e.innerHTML = mark(Number(e.dataset.size) || 36); });
document.querySelectorAll('[data-ic]').forEach((e) => { e.innerHTML = I(e.dataset.ic, 16); });

// ---------------------------------------------------------------- plumbing
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/session') { showLogin(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3400);
}
async function act(fn, okMsg, { reload = true } = {}) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('#view button').forEach((b) => (b.disabled = true));
  try {
    const out = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(out) : okMsg);
    return out;
  } catch (e) { toast(`${e.message}`); } finally { busy = false; if (reload) await refresh(); else document.querySelectorAll('#view button').forEach((b) => (b.disabled = false)); }
}
/** CSP forbids inline style attributes, so dynamic sizes are applied through the CSSOM after render. */
function applyDyn(root = document) {
  root.querySelectorAll('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
  root.querySelectorAll('[data-bg]').forEach((el) => { el.style.background = el.dataset.bg; });
  root.querySelectorAll('[data-h]').forEach((el) => { el.style.height = `${el.dataset.h}%`; });
  root.querySelectorAll('[data-risk]').forEach((el) => { const r = Number(el.dataset.risk); el.style.setProperty('--p', r); el.style.setProperty('--c', r >= 60 ? 'var(--stamp)' : r >= 30 ? 'var(--foil)' : 'var(--seal)'); });
}

// status → [tone, pill label, stamp text, icon]
const STATUS = {
  executed: ['ok', 'Paid via PayPal', 'Paid', 'check'], completed: ['ok', 'Completed', 'Completed', 'check'], funded: ['ok', 'Funds held', 'Held', 'lock'], paid: ['ok', 'Paid', 'Paid', 'check'],
  refunded: ['ok', 'Refunded', 'Refunded', 'undo'], partially_refunded: ['ok', 'Partly refunded', 'Part refund', 'undo'],
  denied: ['bad', 'Blocked', 'Blocked', 'ban'], failed: ['bad', 'Failed', 'Failed', 'alert'], rejected: ['bad', 'Rejected', 'Rejected', 'x'], cancelled: ['bad', 'Cancelled', 'Void', 'x'],
  pending_approval: ['warn', 'Needs your approval', 'Needs you', 'hand'], awaiting_funding: ['warn', 'Awaiting buyer', 'Awaiting buyer', 'clock'], awaiting_buyer: ['warn', 'Awaiting buyer', 'Awaiting buyer', 'clock'], evaluating: ['info', 'Evaluating', 'Reviewing', 'clock'],
};
const tone = (s) => (STATUS[s] || ['info'])[0];
const pill = (s, label) => { const [c, t] = STATUS[s] || ['info', s]; return `<span class="pill ${c}">${esc(label || t)}</span>`; };
const stamp = (r) => { const [c, , t] = STATUS[r.status] || ['info', '', r.status]; const fresh = !firstRender && !seen.has(`${r.id}:${r.status}`); seen.add(`${r.id}:${r.status}`); return `<span class="stamp ${c} ${fresh ? 'fresh' : ''}">${esc(t)}</span>`; };

// ---------------------------------------------------------------- auth
function showLogin() { $('#login').hidden = false; $('#app').hidden = true; setTimeout(() => $('#token').focus(), 50); }
$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const r = await api('POST', '/api/session', { token: $('#token').value });
    csrf = r.csrf;
    $('#token').value = '';
    $('#loginErr').textContent = '';
    await boot();
  } catch (e) { $('#loginErr').textContent = e.message === 'Signed out' ? 'That token is not valid. Copy it again from the terminal.' : e.message; }
});
$('#logout').addEventListener('click', async () => { await api('POST', '/api/session/logout').catch(() => {}); csrf = ''; showLogin(); });

async function boot() {
  const s = await api('GET', '/api/session');
  if (!s.authenticated) return showLogin();
  csrf = s.csrf;
  $('#login').hidden = true;
  $('#app').hidden = false;
  await refresh();
}

// ---------------------------------------------------------------- navigation
const NAV = [
  ['overview', 'Overview', 'gauge'], ['approvals', 'Approvals', 'hand'], ['agents', 'Agents & mandates', 'shield'], ['console', 'Agent console', 'play'],
  ['commerce', 'Orders & refunds', 'cart'], ['escrow', 'Escrow', 'lock'], ['reports', 'Reports', 'chart'], ['audit', 'Audit log', 'scroll'], ['security', 'Security', 'siren'], ['billing', 'Plan & usage', 'card'],
];
function renderNav() {
  const pending = state.metrics.pendingApprovals;
  $('#nav').innerHTML = NAV.map(([id, label, ic]) => `<button class="nav ${view === id ? 'on' : ''}" data-view="${id}" ${view === id ? 'aria-current="page"' : ''}>${I(ic, 18)}${esc(label)}${id === 'approvals' && pending ? `<i class="dot">${pending}</i>` : ''}</button>`).join('');
}
document.addEventListener('click', (ev) => {
  const n = ev.target.closest('[data-view]');
  if (n) { view = n.dataset.view; location.hash = view; render(); if (['reports', 'audit', 'security'].includes(view)) loadExt(view).then(render); $('#view').focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
});
function renderBadges() {
  const i = state.info;
  const live = i.paypal === 'sandbox-live';
  $('#badges').innerHTML = `<span class="badge ${live ? 'ok' : 'warn'}">PayPal ${live ? 'sandbox · live API' : 'sandbox · simulated'}</span><span class="badge ${i.llm ? 'ok' : ''}">AI: ${esc(i.ai)}</span><span class="badge ${state.ledgerStatus.ok ? 'ok' : 'bad'}">Ledger ${state.ledgerStatus.ok ? `intact · ${state.ledgerStatus.length}` : 'tampered'}</span>`;
}

// ---------------------------------------------------------------- shared pieces
const header = (title, sub) => `<header class="page-h"><h1>${esc(title)}</h1><p>${esc(sub)}</p></header>`;
const empty = (t) => `<div class="empty">${esc(t)}</div>`;
const sec = (ic, t) => `<h2 class="sec">${I(ic, 20)}${esc(t)}</h2>`;

function decisionBlock(r) {
  const d = r.decision;
  if (!d) return '';
  const failed = d.policy.checks.filter((c) => !c.pass).length;
  const chips = d.policy.checks.map((c) => `<span class="chip ${c.pass ? 'pass' : 'fail'}" title="${esc(c.detail || '')}">${I(c.pass ? 'check' : 'x', 12)}${esc(c.label)}</span>`).join('');
  return `<details class="chk"><summary>${I(failed ? 'alert' : 'shield', 14)}${failed ? `${failed} hard rule${failed > 1 ? 's' : ''} failed` : 'All hard rules passed'}</summary><div class="chips">${chips}</div></details>
  <div class="ai"><div class="risk" data-risk="${d.ai.risk}" data-v="${d.ai.risk}" title="AI risk score"></div>
  <div><b>AI review: ${esc(d.ai.recommendation)}</b>${d.final !== 'allow' ? ` — decided by <b>${esc(d.decidedBy)}</b>` : ''}<br><span class="hint">${esc(d.ai.rationale)}</span><br><span class="hint">${esc((d.ai.reviewers || []).join(' + '))}${d.ai.llmError ? ' · Claude unavailable, heuristic used' : ''}</span></div></div>`;
}
const approveButtons = (id, label) => `<div class="actions"><button class="btn ok" data-approve="${esc(id)}">${I('check', 16)}${esc(label)}</button><button class="btn no" data-reject="${esc(id)}">${I('x', 16)}Reject</button></div>`;
const nodeIcon = (status) => `<div class="node">${I((STATUS[status] || [])[3] || 'clock', 20)}</div>`;

function requestCard(r) {
  return `<article class="item ${esc(r.status)}">${nodeIcon(r.status)}<div>
    <div class="item-h"><div><span class="amt">${usd(r.amountCents)}</span> <span class="to">to ${esc(r.payee)} · ${esc(r.category)}</span></div>${stamp(r)}</div>
    <div class="purpose">${esc(r.purpose)}</div>${r.evidence ? `<div class="evidence">${esc(r.evidence)}</div>` : ''}${decisionBlock(r)}
    ${r.paypal ? `<div class="hint">PayPal ${esc(r.paypal.rail)} <code>${esc(r.paypal.batchId)}</code> · ${esc(r.paypal.status)}</div>` : ''}${r.error ? `<div class="hint err">${esc(r.error)}</div>` : ''}
    ${r.status === 'pending_approval' ? approveButtons(r.id, 'Approve and pay') : ''}</div></article>`;
}

// ---------------------------------------------------------------- views
function sparkline(series) {
  const max = Math.max(1, ...series.map((s) => s.cents));
  const pts = series.map((s, i) => `${(i / (series.length - 1)) * 300},${88 - (s.cents / max) * 78}`).join(' ');
  return `<svg class="spark" viewBox="0 0 300 96" preserveAspectRatio="none" role="img" aria-label="Net revenue, last 14 days"><polyline points="0,95 ${pts} 300,95" fill="var(--seal)" opacity=".13" stroke="none"/><polyline points="${pts}" fill="none" stroke="var(--seal)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}
const INSIGHT_IC = { good: 'shield', warn: 'hand', bad: 'alert', info: 'info' };

function vOverview() {
  const m = state.metrics;
  const sentence = m.blockedValueCents
    ? `Agents spent <em>${usd(m.agentSpendCents)}</em>. Mandate stopped <em class="bad">${usd(m.blockedValueCents)}</em> that should not have been paid.`
    : `Agents spent <em>${usd(m.agentSpendCents)}</em> inside their mandates. Nothing risky has come through yet.`;
  return `<section class="hero" aria-label="Summary"><p class="lead">${I('sparkles', 16)}Right now</p><h2>${sentence}</h2>
    <div class="hero-figs"><div class="fig">${I('trend', 22)}<div><b>${usd(m.revenueCents)}</b><span>net store revenue · ${m.orders} orders</span></div></div>
    <div class="fig">${I('hand', 22)}<div><b>${m.pendingApprovals}</b><span>waiting for you</span></div></div>
    <div class="fig">${I('fingerprint', 22)}<div><b>${state.ledgerStatus.length}</b><span>hash-chained ledger entries</span></div></div></div>
    ${m.blockedCount ? `<span class="stamp bad">${m.blockedCount} blocked</span>` : ''}</section>
  <div class="grid-2">
    <div class="card"><div class="card-h"><h2>Revenue, last 14 days</h2></div>${sparkline(m.series)}<div class="meta"><span>${I('undo', 14)}Refunded ${usd(m.refundedCents)} (${m.refundRatePct}%)</span><span>${I('receipt', 14)}Average order ${usd(m.avgOrderCents)}</span><span>${I('bot', 14)}${m.aiBlockedCount} stopped by AI</span></div></div>
    <div class="card"><div class="card-h"><h2>What needs attention</h2></div>${state.insights.map((i) => `<div class="insight ${esc(i.level)}">${I(INSIGHT_IC[i.level] || 'info', 18)}<div><b>${esc(i.title)}</b><span>${esc(i.detail)}</span></div></div>`).join('')}</div>
  </div>
  <div class="card"><div class="card-h"><h2>Ask your finance copilot</h2><span class="hint">${state.info.llm ? 'Claude answers from aggregate numbers only — never customer data.' : 'Offline copilot. Add ANTHROPIC_API_KEY to use Claude.'}</span></div>
    <div class="chat" id="chat">${copilotLog.map((c) => `<div class="msg ${c.who}">${esc(c.text)}</div>`).join('') || '<div class="hint">Try “how many requests were blocked?”, “what is my refund rate?” or “how are the agent budgets?”</div>'}</div>
    <form id="askForm" class="row"><label class="sr" for="q">Question</label><input id="q" maxlength="300" placeholder="Ask about revenue, refunds, agents or risk" autocomplete="off"><button class="btn primary" type="submit">${I('send', 16)}Ask</button></form></div>`;
}

function refundCard(f) {
  return `<article class="item ${esc(f.status)}">${nodeIcon(f.status)}<div><div class="item-h"><div><span class="amt">${usd(f.amountCents)}</span> <span class="to">refund on ${esc(f.orderId)} · asked by ${esc(f.requester)}</span></div>${stamp(f)}</div>
  <div class="purpose">“${esc(f.reason)}”</div>${decisionBlock(f)}${f.paypal ? `<div class="hint">PayPal refund <code>${esc(f.paypal.refundId)}</code> · ${esc(f.paypal.status)}</div>` : ''}${f.status === 'pending_approval' ? approveButtons(f.id, 'Approve refund') : ''}</div></article>`;
}

function vApprovals() {
  const item = (label, o, body) => ({ label, body });
  const q = [
    ...state.requests.filter((r) => r.status === 'pending_approval').map((r) => ({ label: 'Payment', body: requestCard(r) })),
    ...state.orders.filter((o) => o.status === 'pending_approval').map((o) => ({ label: 'Agent purchase', body: `<article class="item pending_approval">${nodeIcon('pending_approval')}<div><div class="item-h"><div><span class="amt">${usd(o.totalCents)}</span> <span class="to">${esc(o.purpose)}</span></div>${stamp(o)}</div>${decisionBlock(o)}${approveButtons(o.id, 'Approve purchase')}</div></article>` })),
    ...state.refunds.filter((o) => o.status === 'pending_approval').map((f) => ({ label: 'Refund', body: refundCard(f) })),
    ...state.escrows.filter((e) => e.status === 'pending_approval').map((e) => ({ label: 'Escrow', body: `<article class="item pending_approval">${nodeIcon('pending_approval')}<div><div class="item-h"><div><b>${esc(e.title)}</b> <span class="to">${usd(e.totalCents)} to ${esc(e.payee)}</span></div>${stamp(e)}</div>${decisionBlock(e)}${approveButtons(e.id, 'Approve escrow')}</div></article>` })),
    ...state.escrows.flatMap((e) => e.milestones.filter((m) => m.status === 'review').map((m) => ({ label: 'Milestone review', body: `<article class="item pending_approval">${nodeIcon('pending_approval')}<div><div class="item-h"><div><b>${esc(e.title)} · ${esc(m.name)}</b> <span class="to">${usd(m.amountCents)}</span></div><span class="stamp warn">Needs you</span></div><div class="hint">${esc(m.attempts.at(-1)?.verdict.rationale || '')}</div><div class="actions"><button class="btn ok" data-resolve="${esc(e.id)}|${m.id}|release">${I('check', 16)}Release funds</button><button class="btn no" data-resolve="${esc(e.id)}|${m.id}|reject">${I('x', 16)}Reject</button></div></div></article>` }))),
  ];
  void item;
  return `${header('Approvals', 'Nothing risky moves without you. Approving re-runs every hard rule first.')}${q.length ? q.map((x) => `<div class="hint">${esc(x.label)}</div>${x.body}`).join('') : empty('You are all caught up. Agents are working inside their mandates.')}`;
}

function vAgents() {
  const ms = state.mandates.map((m) => {
    const pct = Math.min(100, Math.round((m.spentCents / m.budgetCents) * 100));
    return `<article class="cheque ${m.revokedAt ? 'revoked' : ''}"><div class="stub">${I('bot', 24)}<b>${esc(m.agent)}</b>${pill(m.revokedAt ? 'cancelled' : 'completed', m.revokedAt ? 'revoked' : 'active')}</div>
      <div class="body"><div class="top"><span class="big">${usd(m.remainingCents)} <small>left of ${usd(m.budgetCents)} per ${esc(m.period)}</small></span></div>
      <div class="ruler" role="img" aria-label="${pct}% of budget used"><i data-w="${pct}"></i></div>
      <div class="meta"><span>${I('coins', 14)}up to ${usd(m.perTxCents)} each</span><span>${I('hand', 14)}you approve over ${usd(m.approvalOverCents)}</span><span>${I('clock', 14)}expires ${esc(m.expiresAt.slice(0, 10))}</span>${m.trust.score !== null ? `<span>${I('shield', 14)}trust ${m.trust.score} · ${esc(m.trust.label.toLowerCase())}</span>` : ''}${m.forecast.daysLeft !== null && !m.revokedAt ? `<span>${I('trend', 14)}at this pace lasts ~${m.forecast.daysLeft} days</span>` : ''}</div>
      <div class="chips">${m.categories.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}${m.payees.map((p) => `<span class="chip">${I('link', 12)}${esc(p)}</span>`).join('') || '<span class="chip">any payee — you approve new ones</span>'}</div>
      <div class="signline">${I('pen', 15)}Signed<span class="sig" title="HMAC-SHA256 over the canonical mandate">${esc(m.signature.slice(0, 18))}</span><span class="grow"></span>${m.revokedAt ? '' : `<button class="btn small" data-rotate="${esc(m.id)}">${I('key', 14)}Rotate token</button><button class="btn small danger" data-revoke="${esc(m.id)}">Revoke</button>`}</div></div></article>`;
  }).join('');
  return `${header('Agents & mandates', 'A mandate is a signed spending permission. Your agent holds a token, never your money.')}
  <div class="grid-2"><div>${ms || empty('No mandates yet. Run a scenario in Agent console, or write one on the right.')}</div>
  <div class="card"><div class="card-h"><h2>Write a mandate</h2><span class="hint">in plain English</span></div>
    <label class="sr" for="nl">Describe the mandate</label><textarea id="nl" rows="3" placeholder="Let my research agent spend up to $150 a week on datasets and API credits, max $60 per purchase, ask me for anything over $30. Only pay @dataset-hub.example."></textarea>
    <div class="row"><button id="draft" class="btn ghost" type="button">${I('sparkles', 16)}Draft with AI</button><span id="draftNote" class="hint"></span></div>
    <form id="mform" class="grid2" autocomplete="off">
      <label>Agent<input name="agent" required placeholder="Research Agent"></label><label>Budget ($)<input name="budget" required inputmode="decimal" placeholder="150"></label>
      <label>Period<select name="period"><option>day</option><option selected>week</option><option>month</option><option>total</option></select></label><label>Per transaction ($)<input name="perTx" inputmode="decimal" placeholder="60"></label>
      <label>Ask me over ($)<input name="approvalOver" inputmode="decimal" placeholder="30"></label><label>Categories<input name="categories" required placeholder="data, software"></label>
      <label class="span2">Allowed payees (emails or @domain)<input name="payees" placeholder="@dataset-hub.example, billing@cloudapi.example"></label>
      <button class="btn primary span2" type="submit">${I('pen', 16)}Sign mandate</button></form>
    ${lastToken ? `<div class="token">${I('key', 18)}<div>Agent token — shown once. Give it to your agent or MCP server:<br><code>${esc(lastToken)}</code></div></div>` : ''}</div></div>`;
}

const SCEN_IC = { legit: 'coins', over_limit: 'ban', needs_human: 'hand', injection: 'bug', lookalike: 'fingerprint', agent_shop: 'cart', refund_auto: 'undo', refund_attack: 'alert', escrow: 'lock' };
const THREAT = new Set(['over_limit', 'injection', 'lookalike', 'refund_attack']);
function vConsole() {
  return `${header('Agent console', 'Replay what an autonomous agent might try. Every button goes through the real engine and the PayPal rail.')}
  <div class="scen">${state.scenarios.map((s) => `<button data-scn="${s.id}" class="${THREAT.has(s.id) ? 'threat' : ''}">${I(SCEN_IC[s.id] === 'bug' ? 'alert' : SCEN_IC[s.id] || 'zap', 20)}<b>${esc(s.title)}</b><span>${esc(s.blurb)}</span></button>`).join('')}</div>
  ${customRequestCard()}${sec('scroll', 'Latest decisions')}${state.requests.length ? state.requests.slice(0, 8).map(requestCard).join('') : empty('Nothing yet. Pick a scenario above.')}`;
}

function vCommerce() {
  return `${header('Orders & refunds', 'Store orders settle through PayPal checkout. Refunds are checked by rules and AI, then paid back through PayPal.')}
  <div class="card"><div class="card-h"><h2>Orders</h2><span class="grow"></span><a class="btn small" href="/shop.html" target="_blank" rel="noopener">${I('store', 15)}Open storefront</a></div>${state.orders.length ? `${gridTools('orders')}<div id="ordersGrid" class="ag-theme-quartz mgrid noclick"></div><p class="poweredby">Table by AG Grid Community</p>` : empty('No orders yet. Run “Agent shops the store” or buy something in the storefront.')}</div>
  ${sec('undo', 'Refund requests')}${state.refunds.length ? state.refunds.map(refundCard).join('') : empty('No refund requests.')}`;
}

function vEscrow() {
  const live = state.info.paypal === 'sandbox-live';
  const cards = state.escrows.slice(0, 6).map((e) => `<article class="item ${esc(e.status)}">${nodeIcon(e.status)}<div><div class="item-h"><div><b>${esc(e.title)}</b><br><span class="to">${usd(e.totalCents)} held for ${esc(e.payee)} · ${usd(e.capturedCents)} released</span></div>${stamp(e)}</div>${e.decision ? decisionBlock(e) : ''}
    ${e.paypal ? `<div class="hint">PayPal order <code>${esc(e.paypal.orderId)}</code>${e.paypal.authorizationId ? ` · authorization <code>${esc(e.paypal.authorizationId)}</code>` : ''}</div>` : ''}
    ${e.milestones.map((m) => { const last = m.attempts.at(-1); return `<div class="ms"><div><b>${esc(m.name)}</b> · ${usd(m.amountCents)} ${pill(m.status === 'released' ? 'completed' : m.status === 'review' ? 'pending_approval' : 'evaluating', m.status)}<small>${m.criteria.map(esc).join(' · ')}</small>${last ? `<small>Verifier: <b>${esc(last.verdict.recommendation)}</b> (${Math.round(last.verdict.score * 100)}%) — ${esc(last.verdict.rationale)}</small>` : ''}</div><div class="actions">${m.status === 'review' ? `<button class="btn small ok" data-resolve="${esc(e.id)}|${m.id}|release">Release</button><button class="btn small no" data-resolve="${esc(e.id)}|${m.id}|reject">Reject</button>` : ''}</div></div>`; }).join('')}
    <div class="actions">${e.status === 'pending_approval' ? `<button class="btn ok" data-approve="${esc(e.id)}">${I('check', 16)}Approve escrow</button>` : ''}${e.status === 'awaiting_funding' ? `<button class="btn primary" data-fund="${esc(e.id)}">${I('card', 16)}${live ? 'I approved in PayPal — authorise' : 'Approve as sandbox buyer'}</button>${e.paypal?.approveUrl && live ? `<a class="btn" href="${esc(e.paypal.approveUrl)}" target="_blank" rel="noopener">Open PayPal checkout ${I('external', 14)}</a>` : ''}` : ''}${e.status === 'funded' ? `<button class="btn small danger" data-void="${esc(e.id)}">Cancel and void the remaining hold</button>` : ''}</div></div></article>`).join('');
  return `${header('Milestone escrow', 'Authorise once with PayPal. Each milestone is captured only after the AI verifier confirms the work.')}${cards || empty('No escrows yet. Run “Freelancer escrow” in Agent console.')}`;
}

const POSTURE = [
  ['Signed mandates', 'HMAC-SHA256 over every limit. Edit the stored file and every payment is denied.', 'pen'], ['AI can only tighten', 'The final answer is the strictest of rules and AI. Untrusted text is fenced.', 'shield'],
  ['Operator sign-in', 'Admin token → HttpOnly, SameSite=Strict session with CSRF token and Origin check.', 'key'], ['Agent isolation', 'One bearer token per mandate, stored as a hash, rotatable. No agent route can approve.', 'bot'],
  ['No double spend', 'One serial queue plus PayPal-Request-Id idempotency on every call.', 'lock'], ['Strict CSP', 'No inline script or style. Frames denied. No sniffing, no referrer.', 'shield'],
  ['Rate limits', 'Login, agent, storefront and global buckets, each with Retry-After.', 'clock'], ['Signed webhooks', 'PayPal signatures verified server-side. Events are idempotent.', 'check'],
  ['Sandbox only', 'The PayPal client refuses any host except api-m.sandbox.paypal.com.', 'ban'], ['Tamper-evident log', 'Every decision is hash-chained with SHA-256.', 'fingerprint'],
];
function vBilling() {
  const b = state.billing;
  const pct = Math.min(100, Math.round((b.used / b.plan.requestsPerMonth) * 100));
  return `${header('Plan & usage', 'Mandate is itself a SaaS. Plans are billed through PayPal Subscriptions.')}
  <div class="card"><div class="card-h"><h2>This month</h2><span class="pill">${esc(b.plan.name)} plan</span></div><div class="ruler"><i data-w="${pct}"></i></div><div class="meta"><span><b>${b.used.toLocaleString()}</b> of ${b.plan.requestsPerMonth.toLocaleString()} governed requests</span><span>${I('bot', 14)}up to ${b.plan.agents} agent mandates</span></div></div>
  <div class="plans">${b.plans.map((p) => `<article class="plan ${p.id === b.tenant.plan ? 'on' : ''}"><h3>${esc(p.name)}</h3><div class="price">${p.priceCents ? `${usd(p.priceCents)}<small> / month</small>` : 'Free'}</div><ul>${p.features.map((f) => `<li>${I('check', 15)}${esc(f)}</li>`).join('')}</ul>${p.id === b.tenant.plan ? '<span class="stamp ok">Current plan</span>' : p.priceCents ? `<button class="btn primary" data-sub="${esc(p.id)}">${I('card', 16)}Subscribe with PayPal</button>` : ''}</article>`).join('')}</div>
  ${b.tenant.subscription ? `<p class="hint">Subscription <code>${esc(b.tenant.subscription.id)}</code> · ${esc(b.tenant.subscription.status)}${b.tenant.subscription.status !== 'ACTIVE' && b.tenant.subscription.approveUrl ? ` · <a href="${esc(b.tenant.subscription.approveUrl)}" target="_blank" rel="noopener">approve in PayPal</a>` : ''}</p>` : ''}`;
}

// ================================================================ AG Grid (Community, MIT — vendored in /vendor/ag-grid)
const grids = new Map(); // element id -> grid api
const gridState = {};     // element id -> saved column/filter/sort/pagination state, restored after every re-render
let quick = { audit: '', tx: '', orders: '' };
let density = localStorage.getItem('mandate.density') || 'comfortable';
const ROW_H = { comfortable: 46, compact: 34 };

function destroyGrids() { for (const a of grids.values()) { try { a.destroy(); } catch { /* already gone */ } } grids.clear(); }

function mountGrid(id, options, mode) {
  const el = document.getElementById(id);
  if (!el || !window.agGrid) { if (el) el.innerHTML = '<div class="empty">The data grid failed to load. Reload the page.</div>'; return null; }
  const api = window.agGrid.createGrid(el, {
    rowHeight: ROW_H[density], headerHeight: 40, floatingFiltersHeight: 38,
    pagination: true, paginationPageSize: 25, paginationPageSizeSelector: [10, 25, 50, 100],
    autoSizeStrategy: { type: 'fitGridWidth', defaultMinWidth: 70 },
    suppressCellFocus: false, animateRows: false, enableCellTextSelection: true, ensureDomOrder: true,
    defaultColDef: { sortable: true, resizable: true, filter: true, floatingFilter: true, minWidth: 90, suppressHeaderMenuButton: true },
    initialState: gridState[id],
    quickFilterText: quick[mode] || '',
    overlayNoRowsTemplate: '<span class="hint">Nothing matches these filters.</span>',
    onGridPreDestroyed: (e) => { gridState[id] = e.state; },
    ...options,
  });
  grids.set(id, api);
  return api;
}
const rowHtml = (fn) => (p) => fn(p.data ?? {}, p);

const actorCell = rowHtml((r) => `<span class="actor ${esc(String(r.actor).split('/')[0])}">${esc(r.actor)}</span>`);
const statusCell = rowHtml((r) => pill(r.status));
const moneyCell = (p) => (p.value == null ? '' : usd(p.value));

function auditColumns() {
  return [
    { field: 'seq', headerName: '#', width: 76, minWidth: 70, filter: 'agNumberColumnFilter', sort: 'desc', cellRenderer: rowHtml((e) => `<span class="${e.ok ? '' : 'seq-bad'}" ${''}>${e.seq}</span>`) },
    { field: 'at', headerName: 'Time (UTC)', width: 130, valueFormatter: (p) => String(p.value).slice(5, 19).replace('T', ' ') },
    { field: 'type', headerName: 'Event', minWidth: 215, flex: 2, cellRenderer: rowHtml((e) => `<span class="ev">${I(EV_IC[e.type.split('.')[0]] || 'scroll', 16)} <b>${esc(e.type)}</b></span>`) },
    { field: 'actor', headerName: 'Actor', width: 108, cellRenderer: actorCell },
    { field: 'ref', headerName: 'Item', width: 138, cellRenderer: rowHtml((e) => `<code>${esc(e.ref)}</code>`) },
    { colId: 'details', headerName: 'Details', flex: 3, minWidth: 160, valueGetter: (p) => sumOf(p.data?.data), tooltipValueGetter: (p) => JSON.stringify(p.data?.data) },
    { field: 'ok', headerName: 'Chain', width: 104, filter: false, floatingFilter: false, cellRenderer: rowHtml((e) => (e.ok ? `<span class="pill ok">${I('check', 12)}intact</span>` : `<span class="pill bad">${I('alert', 12)}broken</span>`)) },
    { field: 'hash', headerName: 'Hash', width: 130, hide: true, cellRenderer: rowHtml((e) => `<code>${esc(e.hash.slice(0, 14))}…</code>`) },
  ];
}

function mountAuditGrid() {
  const rows = ext.audit?.entries || [];
  const api = mountGrid('auditGrid', {
    columnDefs: auditColumns(), rowData: rows, getRowId: (p) => String(p.data.seq), rowClass: undefined,
    getRowClass: (p) => (p.data && !p.data.ok ? 'broken' : ''), tooltipShowDelay: 400,
    onRowClicked: (e) => { drawerFresh = true; drawerRef = e.data.ref; ext.proof = null; render(); loadExt('audit').then(render); },
  }, 'audit');
  return api;
}

function mountTxGrid() {
  mountGrid('txGrid', {
    columnDefs: [
      { field: 'at', headerName: 'Date', width: 120, sort: 'desc', valueFormatter: (p) => String(p.value).slice(0, 10) },
      { field: 'kind', headerName: 'Type', width: 140 },
      { field: 'party', headerName: 'Counterparty', flex: 1.4, minWidth: 190 },
      { field: 'category', headerName: 'Category', width: 120 },
      { field: 'amountCents', headerName: 'Amount', width: 130, type: 'rightAligned', filter: 'agNumberColumnFilter', valueFormatter: moneyCell },
      { field: 'status', headerName: 'Outcome', width: 190, cellRenderer: statusCell },
      { field: 'decidedBy', headerName: 'Decided by', width: 130, cellRenderer: rowHtml((r) => (r.decidedBy ? `<span class="actor ${esc(r.decidedBy)}">${esc(r.decidedBy)}</span>` : '')) },
      { field: 'risk', headerName: 'AI risk', width: 140, filter: 'agNumberColumnFilter', cellRenderer: rowHtml((r) => (r.risk === '' ? '' : `<span class="cellbar ${r.risk >= 60 ? 'high' : r.risk >= 30 ? 'mid' : ''}"><i data-w="${Math.max(4, r.risk)}"></i><b>${r.risk}</b></span>`)) },
      { field: 'note', headerName: 'Purpose', flex: 2, minWidth: 220 },
    ],
    rowData: ext.tx || [], getRowId: (p) => p.data.id,
    onRowClicked: (e) => { drawerFresh = true; drawerRef = e.data.id; ext.proof = null; render(); loadExt('reports').then(render); },
    onFirstDataRendered: () => applyDyn(document.getElementById('txGrid')), onPaginationChanged: () => applyDyn(document.getElementById('txGrid')), onSortChanged: () => applyDyn(document.getElementById('txGrid')),
  }, 'tx');
}

function mountOrdersGrid() {
  mountGrid('ordersGrid', {
    columnDefs: [
      { field: 'id', headerName: 'Order', width: 150, cellRenderer: rowHtml((o) => `<code>${esc(o.id)}</code>`) },
      { colId: 'item', headerName: 'Item', flex: 1.6, minWidth: 200, valueGetter: (p) => p.data.items[0].name },
      { colId: 'buyer', headerName: 'Buyer', flex: 1.2, minWidth: 170, valueGetter: (p) => (p.data.mandateId ? 'AI agent' : p.data.customerEmail) },
      { field: 'totalCents', headerName: 'Total', width: 120, type: 'rightAligned', filter: 'agNumberColumnFilter', valueFormatter: moneyCell },
      { field: 'status', headerName: 'Status', width: 190, cellRenderer: statusCell },
      { colId: 'actions', headerName: '', width: 250, filter: false, floatingFilter: false, sortable: false, cellRenderer: rowHtml((o) => `${o.status === 'awaiting_buyer' ? `<button class="btn small" data-pay="${esc(o.id)}">${state.info.paypal === 'sandbox-live' ? 'Check approval' : 'Pay as sandbox buyer'}</button>${o.paypal?.approveUrl && state.info.paypal === 'sandbox-live' ? ` <a class="btn small" href="${esc(o.paypal.approveUrl)}" target="_blank" rel="noopener">Open PayPal</a>` : ''}` : ''}${['paid', 'partially_refunded'].includes(o.status) ? `<button class="btn small" data-orefund="${esc(o.id)}">Refund…</button>` : ''}`) },
    ],
    rowData: state.orders, getRowId: (p) => p.data.id, domLayout: 'autoHeight', paginationPageSize: 10,
  }, 'orders');
}

function mountGrids() {
  if (view === 'audit' && ext.audit) mountAuditGrid();
  if (view === 'reports' && ext.tx) mountTxGrid();
  if (view === 'commerce') mountOrdersGrid();
}

const gridTools = (mode, extra = '') => `<div class="gtools"><div class="search">${I('search', 16)}<label class="sr" for="gq-${mode}">Quick filter</label><input id="gq-${mode}" data-gq="${mode}" value="${esc(quick[mode])}" placeholder="Quick filter across every column…" autocomplete="off"></div>
  <div class="seg" role="group" aria-label="Row density"><button data-density="comfortable" class="${density === 'comfortable' ? 'on' : ''}">Comfortable</button><button data-density="compact" class="${density === 'compact' ? 'on' : ''}">Compact</button></div>
  <button class="btn" data-gexport="${mode}">${I('download', 15)}Export view (CSV)</button><button class="btn ghost" data-greset="${mode}">${I('refresh', 15)}Reset filters</button>${extra}</div>`;
const GRID_ID = { audit: 'auditGrid', tx: 'txGrid', orders: 'ordersGrid' };

// ================================================================ reports / audit / security
const ext = { report: null, audit: null, sec: null, proof: null, tx: null };
let reportDays = 30;
let auditF = { q: '', type: '', actor: '', limit: 50 };
let drawerRef = null;
let drawerFresh = false;

async function loadExt(v) {
  try {
    if (v === 'reports') { ext.report = await api('GET', `/api/reports?days=${reportDays}`); ext.tx = await api('GET', '/api/transactions'); }
    if (v === 'audit') ext.audit = await api('GET', '/api/audit?limit=1000');
    if (v === 'security') ext.sec = await api('GET', '/api/security-log');
    if (drawerRef) ext.proof = await api('GET', `/api/audit/proof/${encodeURIComponent(drawerRef)}`).catch(() => null);
  } catch (e) { if (e.message !== 'Signed out') toast(e.message); }
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function recommendations(r) {
  const out = [];
  const t = r.totals;
  if (r.refunds.ratePct > 15) out.push(['bad', 'alert', `Refund rate is ${r.refunds.ratePct}%`, 'Above 15%. Review product quality and look at the refund reasons that were escalated.']);
  for (const a of r.agents) {
    if (a.forecast.daysLeft !== null && a.forecast.daysLeft < 3) out.push(['warn', 'clock', `${a.agent} will run out of budget in about ${a.forecast.daysLeft} days`, `At ${usd(a.forecast.perDayCents)}/day. Raise the mandate or expect denials.`]);
    if (a.trust.score !== null && a.trust.score < 60) out.push(['bad', 'shield', `${a.agent} has a low trust score (${a.trust.score})`, `${a.trust.blocked} blocked and ${a.trust.flagged} manipulation attempts. Consider revoking and rotating its token.`]);
  }
  if (r.decisions.byAI > 0) out.push(['good', 'bot', `The AI layer caught ${r.decisions.byAI} request${r.decisions.byAI > 1 ? 's' : ''} the hard rules would have allowed`, 'Those are the cases a rules-only guardrail misses.']);
  if (r.decisions.escalated > 0 && r.decisions.escalated / Math.max(1, r.totals.requests) > 0.3) out.push(['warn', 'hand', 'Over 30% of requests need your approval', 'Raise the “ask me over” threshold or add trusted payees to cut approval fatigue.']);
  if (t.requests === 0) out.push(['info', 'info', 'No activity in this period', 'Run a scenario in Agent console to generate data.']);
  if (!out.length) out.push(['good', 'check', 'Nothing needs changing', 'Budgets, approvals and refunds all look healthy.']);
  return out;
}

function vReports() {
  const r = ext.report;
  const rangeBtn = (d, l) => `<button data-days="${d}" class="${reportDays === d ? 'on' : ''}">${l}</button>`;
  const bar = `<div class="toolbar"><div class="seg" role="group" aria-label="Report period">${rangeBtn(7, '7 days')}${rangeBtn(30, '30 days')}${rangeBtn(90, '90 days')}${rangeBtn(0, 'All time')}</div><span class="grow"></span>
    <a class="btn small" href="/api/reports/export?type=transactions&format=csv">${I('download', 15)}Transactions CSV</a><a class="btn small" href="/api/reports/export?type=blocked&format=csv">${I('download', 15)}Blocked CSV</a><a class="btn small" href="/api/reports/export?type=ledger&format=json">${I('download', 15)}Ledger JSON</a><button class="btn small" data-print>${I('printer', 15)}Print / save PDF</button></div>`;
  if (!r) return `${header('Reports', 'Money, agents, risk and refunds in one place.')}${bar}${empty('Loading report…')}`;
  const t = r.totals; const d = r.decisions;
  const period = reportDays ? `the last ${reportDays} days` : 'all time';
  const brief = `In ${period} the store took <b>${usd(t.netCents)}</b> net from <b>${t.orders}</b> paid order${t.orders === 1 ? '' : 's'} (refund rate ${r.refunds.ratePct}%). Agents made <b>${t.agentTransactions}</b> transaction${t.agentTransactions === 1 ? '' : 's'} worth <b>${usd(t.agentSpendCents)}</b>. Mandate blocked <b>${usd(t.blockedCents)}</b> across <b>${t.blockedCount}</b> request${t.blockedCount === 1 ? '' : 's'}${d.byAI ? `, ${d.byAI} of them caught by AI rather than hard rules` : ''}.`;
  const tile = (ic, label, val, cls = '') => `<div class="tile ${cls}"><span>${I(ic, 14)}${esc(label)}</span><b>${val}</b></div>`;
  const trustCell = (a) => (a.trust.score === null ? '<span class="hint">no history</span>' : `<span class="trust ${a.trust.score >= 80 ? '' : a.trust.score >= 50 ? 'mid' : 'low'}"><i><b data-w="${a.trust.score}"></b></i>${a.trust.score} · ${esc(a.trust.label)}</span>`);
  return `${header('Reports', 'What happened, what it cost, what was stopped — with numbers you can export.')}${bar}
  <div class="brief">${I('clipboard', 26)}<p>${brief}</p></div>
  <div class="tiles">${tile('coins', 'Gross sales', usd(t.grossCents))}${tile('undo', 'Refunded', usd(t.refundedCents), t.refundedCents ? 'neg' : '')}${tile('trend', 'Net revenue', usd(t.netCents), 'pos')}${tile('bot', 'Agent spend', usd(t.agentSpendCents))}${tile('ban', 'Blocked', usd(t.blockedCents), t.blockedCents ? 'neg' : '')}${tile('zap', 'Requests', t.requests)}</div>
  <div class="card"><div class="card-h"><h2>Daily money flow</h2><span class="hint">hover a bar for the day’s numbers</span></div>${moneyChart(r.series)}</div>
  <div class="grid-2"><div class="card"><div class="card-h"><h2>Where agents spend</h2><span class="hint">by category</span></div>${donut(r.spendByCategory, 'agent spend')}</div>
    <div class="card"><div class="card-h"><h2>Who spends it</h2><span class="hint">by agent</span></div>${hbars(r.spendByAgent)}<div class="card-h top"><h2>Top payees</h2></div>${hbars(r.topPayees, { klass: 'k2' })}</div></div>
  <div class="grid-2"><div class="card"><div class="card-h"><h2>How requests were decided</h2></div>${stacked([{ label: 'Allowed', n: d.allowed, cls: 'a', color: 'var(--c1)' }, { label: 'Sent to you', n: d.escalated, cls: 'e', color: 'var(--c3)' }, { label: 'Blocked', n: d.blocked, cls: 'd', color: 'var(--c4)' }])}
      <p class="hint">Of everything that was held or blocked, <b>${d.byPolicy}</b> was stopped by hard rules and <b>${d.byAI}</b> by the AI reviewer.</p>
      <div class="card-h top"><h2>AI risk scores</h2><span class="hint">number of requests per band</span></div>${histogram(r.riskHistogram)}</div>
    <div class="card"><div class="card-h"><h2>Why things were stopped</h2><span class="hint">rule and AI signals</span></div>${hbars(r.blockedReasons, { fmtv: (n) => `${n}×`, klass: 'k4' })}
      <div class="card-h top"><h2>Refunds</h2></div><div class="meta"><span>${I('undo', 14)}${r.refunds.count} requested</span><span>${I('check', 14)}${r.refunds.auto} auto-approved</span><span>${I('hand', 14)}${r.refunds.escalated} sent to you</span><span>${I('ban', 14)}${r.refunds.denied} declined</span></div></div></div>
  <div class="card"><div class="card-h"><h2>Agents: budget, trust and forecast</h2></div>${r.agents.length ? `<div class="tablewrap"><table><thead><tr><th>Agent</th><th class="num">Spent</th><th class="num">Left</th><th>Burn rate</th><th>Runs out in</th><th>Trust</th></tr></thead><tbody>${r.agents.map((a) => `<tr><td><b>${esc(a.agent)}</b></td><td class="num">${usd(a.spentCents)}</td><td class="num">${usd(a.remainingCents)}</td><td>${usd(a.forecast.perDayCents)}/day</td><td>${a.forecast.daysLeft === null ? '—' : `${a.forecast.daysLeft} days`}</td><td>${trustCell(a)}</td></tr>`).join('')}</tbody></table></div>` : empty('No active mandates.')}</div>
  <div class="card"><div class="card-h"><h2>Every transaction</h2><span class="hint">sort, filter and export — select a row for its proof</span></div>${gridTools('tx')}<div id="txGrid" class="ag-theme-quartz mgrid tx-grid"></div><p class="poweredby">Table by AG Grid Community</p></div>
  <div class="grid-2"><div class="card"><div class="card-h"><h2>Top products</h2></div>${hbars(r.topProducts)}</div>
    <div class="card"><div class="card-h"><h2>What to do next</h2><span class="hint">generated from this report</span></div>${recommendations(r).map(([lv, ic, a, b]) => `<div class="reco ${lv}">${I(ic, 18)}<div><b>${esc(a)}</b><span>${esc(b)}</span></div></div>`).join('')}</div></div>`;
}

const EV_IC = { mandate: 'shield', payment: 'coins', escrow: 'lock', order: 'cart', refund: 'undo', billing: 'card', webhook: 'zap', security: 'siren', human: 'hand' };
const sumOf = (d) => Object.entries(d || {}).filter(([k]) => !['signature'].includes(k)).slice(0, 4).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');

function vAudit() {
  const a = ext.audit;
  if (!a) return `${header('Audit log', 'Every decision, who made it, and cryptographic proof it was not altered.')}${empty('Loading…')}`;
  const ch = a.chain;
  const banner = ch.ok
    ? `<div class="integrity">${I('fingerprint', 22)}<div>Chain intact<br><small>${ch.length} entries · head ${esc(String(ch.head).slice(0, 16))}…</small></div><span class="grow"></span><button class="btn small" id="verify">${I('check', 14)}Verify full chain</button>${state.demoMode ? `<button class="btn small" id="tamper">${I('flask', 14)}Simulate tampering</button>` : ''}</div>`
    : `<div class="integrity bad">${I('alert', 22)}<div>Tampering detected at entry #${ch.brokenAt}<br><small>Entry #${ch.brokenAt} no longer matches its recorded hash, so it and everything after it can’t be trusted.</small></div><span class="grow"></span><button class="btn small" id="verify">${I('fingerprint', 14)}Verify again</button>${a.tampered ? `<button class="btn small" id="restore">${I('refresh', 14)}Restore original</button>` : ''}</div>`;
  return `${header('Audit log', 'Every decision, who made it, and cryptographic proof it was not altered.')}${banner}
  ${gridTools('audit', `<a class="btn" href="/api/reports/export?type=ledger&format=json">${I('download', 15)}Full ledger JSON</a>`)}
  <div id="auditGrid" class="ag-theme-quartz mgrid audit-grid"></div>
  <p class="poweredby">Showing ${a.entries.length} of ${a.total} entries · select a row to see everything that led to it · table by AG Grid Community</p>`;
}

function drawer() {
  const p = ext.proof;
  if (!drawerRef) return '';
  if (!p) return `<div class="scrim" data-close></div><aside class="drawer ${drawerFresh ? 'anim' : ''}" role="dialog" aria-label="Details"><header><h3>${esc(drawerRef)}</h3><button class="btn small ghost" data-close aria-label="Close">${I('x', 16)}</button></header><div class="dbody">${empty('Nothing on record except the ledger line itself.')}</div></aside>`;
  const it = p.item || {};
  return `<div class="scrim" data-close></div><aside class="drawer ${drawerFresh ? 'anim' : ''}" role="dialog" aria-label="Proof for ${esc(p.ref)}"><header>${I('fingerprint', 22)}<h3>${esc(p.ref)}</h3><a class="btn small" download="proof-${esc(p.ref)}.json" href="data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(p, null, 2))}">${I('download', 14)}Proof JSON</a><button class="btn small ghost" data-close aria-label="Close">${I('x', 16)}</button></header>
  <div class="dbody">
    ${it.status ? `<dl class="kv"><dt>Status</dt><dd>${pill(it.status)}</dd>${it.amountCents || it.totalCents ? `<dt>Amount</dt><dd>${usd(it.amountCents || it.totalCents)}</dd>` : ''}${it.payee ? `<dt>Payee</dt><dd>${esc(it.payee)}</dd>` : ''}${it.purpose ? `<dt>Purpose</dt><dd>${esc(it.purpose)}</dd>` : ''}${it.decision ? `<dt>Decided by</dt><dd>${esc(it.decision.decidedBy)} → ${esc(it.decision.final)}</dd><dt>AI risk</dt><dd>${it.decision.ai.risk} — ${esc(it.decision.ai.rationale)}</dd>` : ''}</dl>` : ''}
    ${it.decision ? `<div><b>Hard rules</b><div class="chips">${it.decision.policy.checks.map((c) => `<span class="chip ${c.pass ? 'pass' : 'fail'}">${I(c.pass ? 'check' : 'x', 12)}${esc(c.label)}</span>`).join('')}</div></div>` : ''}
    <div><b>Timeline (${p.entries.length} ledger entries)</b><div class="chain">${p.entries.map((e) => `<div class="step">${I(EV_IC[e.type.split('.')[0]] || 'scroll', 16)}<div><b>#${e.seq} ${esc(e.type)}</b> <span class="actor ${esc(e.actor)}">${esc(e.actor)}</span><br><span class="hint">${esc(e.at)}</span><br><code>hash ${esc(e.hash.slice(0, 24))}… ← prev ${esc(e.prev.slice(0, 12))}…</code></div></div>`).join('')}</div></div>
    <div><b>Raw ledger data</b><pre class="json">${esc(JSON.stringify(p.entries.map(({ seq, at, type, data, prev, hash }) => ({ seq, at, type, data, prev, hash })), null, 2))}</pre></div>
    <p class="hint">${esc(p.note)}</p>
  </div></aside>`;
}

const SEC_TONE = { login_ok: ['good', 'check', 'Operator signed in'], logout: ['good', 'logout', 'Operator signed out'], login_failed: ['warn', 'key', 'Failed sign-in'], rate_limited: ['warn', 'clock', 'Rate limit hit'], unauthenticated_request: ['warn', 'ban', 'Request without a session'], csrf_or_origin_blocked: ['bad', 'shield', 'CSRF / cross-origin blocked'], agent_token_rejected: ['bad', 'bot', 'Unknown agent token'], webhook_rejected: ['bad', 'zap', 'Webhook signature rejected'], kill_switch_on: ['bad', 'siren', 'Kill switch engaged'], kill_switch_off: ['good', 'power', 'Agents resumed'], demo_tamper: ['warn', 'flask', 'Demo: ledger tampered'] };
function vSecurity() {
  const s = ext.sec;
  const frozen = state.frozen;
  const kill = `<div class="killcard ${frozen ? 'frozen' : ''}"><div class="big">${I(frozen ? 'siren' : 'power', 28)}</div><div><h2>${frozen ? 'Agents are frozen' : 'Kill switch'}</h2><p>${frozen ? `Every agent request is being denied by a hard rule. Frozen ${esc(frozen.at.slice(0, 19).replace('T', ' '))} UTC by ${esc(frozen.by)}.` : 'One click stops all agent spending immediately, across every mandate. Pending approvals stay pending. You can resume at any time.'}</p></div>${frozen ? `<button class="btn resume" data-freeze="0">${I('play', 16)}Resume agents</button>` : `<button class="btn kill" data-freeze="1">${I('siren', 16)}Freeze all agents</button>`}</div>`;
  const ev = (s?.events || []).map((e) => { const [tn, ic, label] = SEC_TONE[e.type] || ['good', 'info', e.type]; return `<div class="sevt"><span class="hint">${esc(e.at.slice(5, 19).replace('T', ' '))}</span><span class="sevchip ${tn}">${I(ic, 16)}${esc(label)}</span><code>${esc(e.ip)}</code><span class="d">${esc(JSON.stringify(e.detail || {}))}</span></div>`; }).join('');
  return `${header('Security', 'Controls, protections and a record of everything that tried to get in.')}${kill}
  <div class="card"><div class="card-h"><h2>How this is protected</h2></div><div class="posture">${POSTURE.map(([a, b, ic]) => `<div>${I(ic, 18)}<div><b>${esc(a)}</b><span>${esc(b)}</span></div></div>`).join('')}</div></div>
  <div class="card"><div class="card-h"><h2>Security events</h2><span class="hint">sign-ins, blocked requests, rate limits, webhooks</span><span class="grow"></span><a class="btn small" href="/api/reports/export?type=security&format=csv">${I('download', 15)}CSV</a></div>
  ${s ? `<div class="alog"><div class="sevt head"><span>Time (UTC)</span><span>Event</span><span>Source</span><span>Detail</span></div>${ev || empty('No security events yet.')}</div>` : empty('Loading…')}</div>`;
}

// ---- what-if / custom request (Agent console)
let whatif = null;
const wfv = {}; // remembers the form fields across re-renders
const wv = (k, d) => esc(wfv[k] ?? d);
function customRequestCard() {
  const ms = state.mandates.filter((m) => !m.revokedAt);
  if (!ms.length) return '';
  return `<div class="card"><div class="card-h"><h2>Try your own request</h2><span class="hint">check it first without moving money, or send it for real</span></div>
  <form id="whatifForm" class="whatif"><label>Agent<select name="mandateId">${ms.map((m) => `<option value="${esc(m.id)}" ${wfv.mandateId === m.id ? 'selected' : ''}>${esc(m.agent)}</option>`).join('')}</select></label>
    <label>Payee email<input name="payee" required value="${wv('payee', 'ops@dataset-hub.example')}"></label><label>Amount ($)<input name="amount" required inputmode="decimal" value="${wv('amount', '20.00')}"></label>
    <label>Category<select name="category">${['data', 'software', 'research', 'design', 'writing', 'marketing', 'travel', 'contractor', 'other'].map((c) => `<option ${wfv.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <label class="span2">What is it for?<input name="purpose" required value="${wv('purpose', 'Dataset sample pack')}"></label><label class="span2">Invoice or evidence text<input name="evidence" value="${wv('evidence', '')}" placeholder="Paste invoice text — try adding “ignore previous instructions”"></label>
    <div class="actions span2"><button class="btn" type="submit" data-mode="check">${I('flask', 16)}Check only</button><button class="btn primary" type="submit" data-mode="send">${I('send', 16)}Send request</button></div></form>
  ${whatif ? `<div class="verdict"><span class="stamp ${whatif.final === 'allow' ? 'ok' : whatif.final === 'escalate' ? 'warn' : 'bad'}">${whatif.final === 'allow' ? 'Would pay' : whatif.final === 'escalate' ? 'Would ask you' : 'Would block'}</span><div><b>${esc(whatif.ai.rationale)}</b><div class="chips">${whatif.policy.checks.map((c) => `<span class="chip ${c.pass ? 'pass' : 'fail'}" title="${esc(c.detail || '')}">${I(c.pass ? 'check' : 'x', 12)}${esc(c.label)}</span>`).join('')}</div><span class="hint">Dry run: nothing was stored, logged or paid.</span></div></div>` : ''}</div>`;
}

// ---- command palette
const ACTIONS = () => [
  ...NAV.map(([id, label, ic]) => ({ label: `Go to ${label}`, ic, run: () => { view = id; location.hash = id; render(); } })),
  { label: state?.frozen ? 'Resume all agents' : 'Freeze all agents (kill switch)', ic: 'siren', run: () => act(J('POST', '/api/freeze', { on: !state.frozen }), state.frozen ? 'Agents resumed' : 'All agents frozen') },
  { label: 'Verify audit chain', ic: 'fingerprint', run: () => act(J('GET', '/api/ledger/verify'), (r) => (r.ok ? `Chain intact: ${r.length} entries` : `Chain broken at entry ${r.brokenAt}`)) },
  { label: 'Download transactions CSV', ic: 'download', run: () => { location.href = '/api/reports/export?type=transactions&format=csv'; } },
  ...(state?.scenarios || []).map((s) => ({ label: `Run scenario: ${s.title}`, ic: 'play', run: () => act(J('POST', `/api/scenarios/${s.id}`), (r) => `${s.title}: ${String(r.status).replace(/_/g, ' ')}`) })),
];
let palIdx = 0;
function openPalette() {
  if ($('#palette')) return;
  const host = document.createElement('div');
  host.id = 'palette'; host.className = 'palette';
  host.innerHTML = `<div class="pal" role="dialog" aria-label="Command palette"><label class="sr" for="palq">Type a command</label><input id="palq" placeholder="Type a command or page name…" autocomplete="off"><ul id="pall" role="listbox"></ul></div>`;
  document.body.appendChild(host);
  const input = $('#palq');
  const list = () => { const q = input.value.toLowerCase(); return ACTIONS().filter((a) => a.label.toLowerCase().includes(q)); };
  const paint = () => { const l = list(); palIdx = Math.min(palIdx, Math.max(0, l.length - 1)); $('#pall').innerHTML = l.map((a, i) => `<li role="option" class="${i === palIdx ? 'on' : ''}" data-i="${i}">${I(a.ic, 18)}${esc(a.label)}</li>`).join('') || '<li>No matches</li>'; };
  const close = () => host.remove();
  const run = (i) => { const a = list()[i]; if (a) { close(); a.run(); } };
  input.addEventListener('input', () => { palIdx = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') { palIdx = Math.min(list().length - 1, palIdx + 1); paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { palIdx = Math.max(0, palIdx - 1); paint(); e.preventDefault(); }
    else if (e.key === 'Enter') run(palIdx);
  });
  host.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) run(Number(li.dataset.i)); else if (e.target === host) close(); });
  palIdx = 0; paint(); input.focus();
}
$('#paletteBtn').addEventListener('click', openPalette);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && state && !$('#app').hidden) { e.preventDefault(); openPalette(); }
  if (e.key === 'Escape' && drawerRef) { drawerRef = null; ext.proof = null; render(); }
});

const VIEWS = { overview: vOverview, approvals: vApprovals, agents: vAgents, console: vConsole, commerce: vCommerce, escrow: vEscrow, billing: vBilling, reports: vReports, audit: vAudit, security: vSecurity };

function safeView() {
  try { return VIEWS[view](); } catch (e) { console.error(e); return `${header('Something went wrong', 'This screen could not be drawn.')}<div class="empty">${esc(e.message)}. Reload the page; if it keeps happening, restart the server.</div>`; }
}

function render() {
  if (!VIEWS[view]) view = 'overview';
  const el = $('#view');
  const keep = document.activeElement?.id === 'q' ? $('#q').value : null;
  renderNav();
  renderBadges();
  destroyGrids();
  const dr = drawer(); drawerFresh = false;
  el.innerHTML = (state.frozen ? `<div class="banner">${I('siren', 20)}<span>All agents are frozen. Nothing can be spent until you resume.</span><span class="grow"></span><button class="btn small" data-freeze="0">Resume agents</button></div>` : '') + safeView() + dr;
  applyDyn(el);
  mountGrids();
  firstRender = false;
  if (keep !== null && $('#q')) { $('#q').value = keep; $('#q').focus(); }
  const chat = $('#chat'); if (chat) chat.scrollTop = chat.scrollHeight;
}
async function refresh() {
  try { state = await api('GET', '/api/state'); if (['reports', 'audit', 'security'].includes(view)) await loadExt(view); render(); } catch (e) { if (e.message !== 'Signed out') toast(e.message); }
}

// ---------------------------------------------------------------- events
const J = (m, p, b) => () => api(m, p, b);
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-density],[data-gexport],[data-greset],[data-days],[data-print],[data-close],[data-freeze],#more,#tamper,#restore,[data-scn],[data-approve],[data-reject],[data-fund],[data-void],[data-resolve],[data-revoke],[data-rotate],[data-pay],[data-orefund],[data-sub],#verify,#reset,#draft');
  if (!t) return;
  const d = t.dataset;
  if (d.density) { density = d.density; localStorage.setItem('mandate.density', density); for (const a of grids.values()) { a.setGridOption('rowHeight', ROW_H[density]); a.resetRowHeights(); } document.querySelectorAll('[data-density]').forEach((b) => b.classList.toggle('on', b.dataset.density === density)); }
  else if (d.gexport) grids.get(GRID_ID[d.gexport])?.exportDataAsCsv({ fileName: `mandate-${d.gexport}-${new Date().toISOString().slice(0, 10)}.csv`, columnKeys: grids.get(GRID_ID[d.gexport]).getAllDisplayedColumns().map((c) => c.getColId()).filter((id) => id !== 'actions') });
  else if (d.greset) { const api = grids.get(GRID_ID[d.greset]); if (api) { api.setFilterModel(null); api.setGridOption('quickFilterText', ''); quick[d.greset] = ''; const q = document.querySelector(`[data-gq="${d.greset}"]`); if (q) q.value = ''; api.resetColumnState(); } }
  else if (d.days !== undefined) { reportDays = Number(d.days); ext.report = null; render(); loadExt('reports').then(render); }
  else if (t.hasAttribute('data-print')) window.print();
  else if (t.hasAttribute('data-close')) { drawerRef = null; ext.proof = null; render(); }
  else if (d.freeze !== undefined) act(J('POST', '/api/freeze', { on: d.freeze === '1' }), d.freeze === '1' ? 'All agents frozen' : 'Agents resumed');
  else if (t.id === 'tamper') act(J('POST', '/api/demo/tamper'), (r) => `Entry #${r.tamperedSeq} was altered — watch the chain break`);
  else if (t.id === 'restore') act(J('POST', '/api/demo/restore'), 'Original restored');
  else if (d.scn) act(J('POST', `/api/scenarios/${d.scn}`), (r) => `${r.title || r.purpose || 'Scenario'}: ${r.status.replace(/_/g, ' ')}`);
  else if (d.approve) act(J('POST', `/api/approvals/${d.approve}/approve`), (r) => `Approved. Status: ${r.status.replace(/_/g, ' ')}`);
  else if (d.reject) act(J('POST', `/api/approvals/${d.reject}/reject`), 'Rejected');
  else if (d.fund) act(J('POST', `/api/escrows/${d.fund}/fund`), 'Funds authorised on PayPal');
  else if (d.void) act(J('POST', `/api/escrows/${d.void}/void`), 'Escrow cancelled and hold voided');
  else if (d.revoke) act(J('POST', `/api/mandates/${d.revoke}/revoke`), 'Mandate revoked');
  else if (d.rotate) act(async () => { lastToken = (await api('POST', `/api/mandates/${d.rotate}/rotate`)).agentToken; }, 'Token rotated. The old token no longer works.');
  else if (d.pay) act(J('POST', `/api/orders/${d.pay}/pay`), (r) => `Order ${r.status.replace(/_/g, ' ')}`);
  else if (d.orefund) { const reason = prompt('Why is this order being refunded?'); if (reason) act(J('POST', `/api/orders/${d.orefund}/refund`, { reason }), (r) => `Refund ${r.status.replace(/_/g, ' ')}`); }
  else if (d.sub) act(J('POST', '/api/billing/subscribe', { plan: d.sub }), 'Subscription created');
  else if (d.resolve) { const [id, milestoneId, decision] = d.resolve.split('|'); act(J('POST', `/api/escrows/${id}/resolve`, { milestoneId, decision }), decision === 'release' ? 'Milestone released' : 'Milestone rejected'); }
  else if (t.id === 'verify') act(J('GET', '/api/ledger/verify'), (r) => (r.ok ? `Chain intact: ${r.length} entries` : `Chain broken at entry ${r.brokenAt}`));
  else if (t.id === 'reset') { if (confirm('Clear all demo data?')) act(J('POST', '/api/reset'), 'Demo data cleared'); }
  else if (t.id === 'draft') act(async () => {
    const out = await api('POST', '/api/mandates/draft', { text: $('#nl').value });
    const f = $('#mform').elements; const m = out.mandate;
    f.agent.value = m.agent || ''; f.budget.value = m.budget || ''; f.period.value = m.period || 'week'; f.perTx.value = m.perTx || ''; f.approvalOver.value = m.approvalOver || '';
    f.categories.value = (m.categories || []).join(', '); f.payees.value = (m.payees || []).join(', ');
    $('#draftNote').textContent = `Drafted by ${out.provider}. Check the fields, then sign.`;
  }, 'Draft ready. Check the fields before signing.', { reload: false });
});
document.addEventListener('submit', (ev) => {
  const id = ev.target.id;
  if (id === 'mform') {
    ev.preventDefault();
    const f = ev.target.elements;
    const list = (v) => v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    act(async () => { const out = await api('POST', '/api/mandates', { agent: f.agent.value, budget: f.budget.value, period: f.period.value, perTx: f.perTx.value || undefined, approvalOver: f.approvalOver.value || undefined, categories: list(f.categories.value), payees: list(f.payees.value) }); lastToken = out.agentToken; }, 'Mandate signed');
  } else if (id === 'whatifForm') {
    ev.preventDefault();
    const f = ev.target; const mode = ev.submitter?.dataset.mode;
    const body = Object.fromEntries(new FormData(f).entries());
    if (mode === 'check') act(async () => { whatif = await api('POST', '/api/simulate', body); }, 'Dry run complete. Nothing was paid.');
    else act(async () => { whatif = null; const r = await api('POST', '/api/payments', body); return r; }, (r) => `Request ${r.status.replace(/_/g, ' ')}`);
  } else if (id === 'askForm') {
    ev.preventDefault();
    const q = $('#q').value.trim();
    if (!q) return;
    copilotLog.push({ who: 'me', text: q });
    act(async () => { const r = await api('POST', '/api/copilot', { question: q }); copilotLog.push({ who: 'ai', text: `${r.text}` }); });
  }
});
document.addEventListener('input', (ev) => { if (ev.target.form?.id === 'whatifForm') wfv[ev.target.name] = ev.target.value; });
document.addEventListener('change', (ev) => { if (ev.target.form?.id === 'whatifForm') wfv[ev.target.name] = ev.target.value; });
document.addEventListener('input', (ev) => { const m = ev.target.dataset?.gq; if (m) { quick[m] = ev.target.value; grids.get(GRID_ID[m])?.setGridOption('quickFilterText', ev.target.value); } });
let aqT;
window.addEventListener('hashchange', () => { view = (location.hash || '#overview').slice(1); if (state) { render(); if (['reports', 'audit', 'security'].includes(view)) loadExt(view).then(render); } });
boot().catch(() => showLogin());
setInterval(() => { if (!busy && state && !$('#app').hidden && !['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName) && view !== 'agents' && !drawerRef) refresh(); }, 6000);
