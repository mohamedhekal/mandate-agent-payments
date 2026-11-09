import { usage } from './mandate.js';
import { CATALOG } from './commerce.js';
import { fmt } from './money.js';

const DAY = 86_400_000;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const PAID = ['paid', 'partially_refunded', 'refunded'];

/** Who performed an audit entry. Derived from the event type so the ledger itself stays small. */
export function actorOf(e) {
  const t = e.type;
  if (/human_|^human\.|mandate\.(created|revoked|token_rotated)|escrow\.cancelled|billing\./.test(t)) return 'owner';
  if (/\.decision$|deliverable_checked/.test(t)) return e.data?.decidedBy === 'policy' ? 'policy' : 'ai';
  if (/\.requested$|^order\.created|escrow\.deliverable/.test(t)) return t.startsWith('order') ? (e.data?.source === 'agent' ? 'agent' : 'customer') : 'agent';
  if (/executed|paid|refund|milestone_released|funded|order_created|paypal_created|webhook/.test(t)) return 'paypal';
  if (/security\./.test(t)) return 'system';
  return 'system';
}

/** Flatten every money-moving or money-deciding item into one list for reporting and CSV export. */
export function transactions(state) {
  const out = [];
  const dec = (r) => ({ decidedBy: r.decision?.decidedBy || '', risk: r.decision?.ai?.risk ?? '', verdict: r.decision?.final || '' });
  for (const r of Object.values(state.requests)) out.push({ id: r.id, kind: 'agent payment', at: r.createdAt, status: r.status, amountCents: r.amountCents, party: r.payee, category: r.category, actor: 'agent', mandateId: r.mandateId, note: r.purpose, ...dec(r) });
  for (const e of Object.values(state.escrows)) out.push({ id: e.id, kind: 'escrow', at: e.createdAt, status: e.status, amountCents: e.totalCents, party: e.payee, category: e.category, actor: 'agent', mandateId: e.mandateId, note: e.title, ...dec(e) });
  for (const o of Object.values(state.orders)) out.push({ id: o.id, kind: o.mandateId ? 'agent purchase' : 'store order', at: o.createdAt, status: o.status, amountCents: o.totalCents, party: o.mandateId ? o.payee : o.customerEmail, category: o.category, actor: o.mandateId ? 'agent' : 'customer', mandateId: o.mandateId || '', note: o.purpose, ...dec(o) });
  for (const f of Object.values(state.refunds)) out.push({ id: f.id, kind: 'refund', at: f.createdAt, status: f.status, amountCents: f.amountCents, party: state.orders[f.orderId]?.customerEmail || '', category: state.orders[f.orderId]?.category || '', actor: f.requester, mandateId: '', note: f.reason, ...dec(f) });
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function trustScore(state, mandate) {
  const mine = [...Object.values(state.requests), ...Object.values(state.escrows), ...Object.values(state.orders)].filter((r) => r.mandateId === mandate.id);
  if (!mine.length) return { score: null, label: 'No history yet', done: 0, blocked: 0, flagged: 0 };
  const blocked = mine.filter((r) => r.status === 'denied').length;
  const flagged = mine.filter((r) => (r.decision?.ai?.flags || []).some((f) => f.id === 'prompt_injection' || f.id === 'lookalike_payee')).length;
  const done = mine.filter((r) => ['executed', 'paid', 'completed', 'funded', 'partially_refunded', 'refunded'].includes(r.status)).length;
  const score = Math.max(0, Math.min(100, Math.round(100 - (blocked / mine.length) * 45 - flagged * 18 - (mine.length < 3 ? 10 : 0))));
  return { score, label: score >= 80 ? 'Behaving well' : score >= 50 ? 'Watch closely' : 'Risky', done, blocked, flagged };
}

/** Burn-rate forecast: when does this mandate run out at the pace seen so far? */
export function forecast(state, mandate, now) {
  const u = usage(mandate, state, now);
  // Assume at least one day of history so a brand-new mandate does not produce an absurd burn rate.
  const elapsedMs = Math.max(DAY, now - Date.parse(mandate.createdAt));
  const perDay = (u.spentCents / elapsedMs) * DAY;
  const days = perDay > 0 ? u.remainingCents / perDay : null;
  return { perDayCents: Math.round(perDay), daysLeft: days === null ? null : Math.round(days * 10) / 10 };
}

export function buildReport(state, { days = 30, now = Date.now() } = {}) {
  const from = days > 0 ? now - days * DAY : 0;
  const txs = transactions(state).filter((t) => Date.parse(t.at) >= from);
  const real = txs.filter((t) => ['executed', 'paid', 'partially_refunded', 'refunded', 'funded', 'completed'].includes(t.status));
  const blocked = txs.filter((t) => t.status === 'denied' || t.status === 'rejected');
  const orders = Object.values(state.orders).filter((o) => PAID.includes(o.status) && Date.parse(o.paidAt) >= from);
  const refunds = Object.values(state.refunds).filter((r) => Date.parse(r.createdAt) >= from);

  const span = days > 0 ? Math.min(days, 90) : 30;
  const series = Array.from({ length: span }, (_, i) => {
    const d = day(now - (span - 1 - i) * DAY);
    const dayTx = txs.filter((t) => t.at.slice(0, 10) === d);
    return {
      day: d,
      revenueCents: orders.filter((o) => o.paidAt.slice(0, 10) === d).reduce((s, o) => s + o.totalCents, 0),
      refundedCents: refunds.filter((r) => r.status === 'refunded' && r.createdAt.slice(0, 10) === d).reduce((s, r) => s + r.amountCents, 0),
      agentSpendCents: dayTx.filter((t) => t.actor === 'agent' && ['executed', 'paid', 'funded', 'completed'].includes(t.status)).reduce((s, t) => s + t.amountCents, 0),
      blockedCents: dayTx.filter((t) => t.status === 'denied').reduce((s, t) => s + t.amountCents, 0),
    };
  });

  const agentMoney = real.filter((t) => t.actor === 'agent');
  const bucket = (arr, keyFn, valFn = (t) => t.amountCents) => Object.entries(arr.reduce((m, t) => { const k = keyFn(t) || 'unknown'; m[k] = (m[k] || 0) + valFn(t); return m; }, {})).sort((a, b) => b[1] - a[1]).map(([key, cents]) => ({ key, cents }));
  const mandateName = (id) => state.mandates[id]?.agent || id;

  const decided = txs.filter((t) => t.verdict);
  const decisions = {
    allowed: decided.filter((t) => t.verdict === 'allow').length,
    escalated: decided.filter((t) => t.verdict === 'escalate').length,
    blocked: decided.filter((t) => t.verdict === 'deny').length,
    byPolicy: decided.filter((t) => t.verdict !== 'allow' && t.decidedBy === 'policy').length,
    byAI: decided.filter((t) => t.verdict !== 'allow' && t.decidedBy === 'ai').length,
  };
  const risk = [0, 0, 0, 0, 0];
  for (const t of decided) if (t.risk !== '') risk[Math.min(4, Math.floor(t.risk / 20))] += 1;

  const reasons = {};
  for (const r of [...Object.values(state.requests), ...Object.values(state.escrows), ...Object.values(state.orders), ...Object.values(state.refunds)]) {
    if (Date.parse(r.createdAt) < from || !r.decision || r.decision.final === 'allow') continue;
    for (const c of r.decision.policy.checks.filter((c) => !c.pass)) reasons[`rule: ${c.label}`] = (reasons[`rule: ${c.label}`] || 0) + 1;
    for (const f of r.decision.ai.flags || []) reasons[`ai: ${f.id.replace(/_/g, ' ')}`] = (reasons[`ai: ${f.id.replace(/_/g, ' ')}`] || 0) + 1;
  }

  const grossCents = orders.reduce((s, o) => s + o.totalCents, 0);
  const refundedCents = refunds.filter((r) => r.status === 'refunded').reduce((s, r) => s + r.amountCents, 0);
  const products = {};
  for (const o of orders) for (const i of o.items) products[i.sku] = (products[i.sku] || 0) + i.unitCents * i.qty;

  return {
    range: { days, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    totals: {
      grossCents, refundedCents, netCents: grossCents - refundedCents, orders: orders.length,
      agentSpendCents: agentMoney.reduce((s, t) => s + t.amountCents, 0), agentTransactions: agentMoney.length,
      blockedCents: blocked.filter((t) => t.status === 'denied').reduce((s, t) => s + t.amountCents, 0), blockedCount: blocked.length,
      requests: txs.length,
    },
    series,
    spendByCategory: bucket(agentMoney, (t) => t.category),
    spendByAgent: bucket(agentMoney, (t) => mandateName(t.mandateId)),
    topPayees: bucket(agentMoney, (t) => t.party).slice(0, 6),
    topProducts: Object.entries(products).sort((a, b) => b[1] - a[1]).map(([sku, cents]) => ({ key: CATALOG.find((c) => c.sku === sku)?.name || sku, cents })),
    decisions, riskHistogram: risk,
    blockedReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, count]) => ({ key, count })),
    refunds: {
      count: refunds.length, auto: refunds.filter((r) => r.status === 'refunded' && !r.approvedBy && r.decision?.final === 'allow').length,
      escalated: refunds.filter((r) => r.decision?.final === 'escalate').length, denied: refunds.filter((r) => r.status === 'denied').length,
      ratePct: grossCents ? Math.round((refundedCents / grossCents) * 1000) / 10 : 0,
    },
    agents: Object.values(state.mandates).filter((m) => !m.revokedAt).map((m) => ({ id: m.id, agent: m.agent, ...usage(m, state, now), budgetCents: m.budgetCents, trust: trustScore(state, m), forecast: forecast(state, m, now) })),
  };
}

// ------------------------------------------------------------------ CSV
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCSV = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');

export function exportData(state, type, now = Date.now()) {
  if (type === 'ledger') {
    const rows = state.ledger.map((e) => ({ seq: e.seq, at: e.at, type: e.type, actor: actorOf(e), ref: e.ref, data: JSON.stringify(e.data), prev: e.prev, hash: e.hash }));
    return { name: 'audit-ledger', rows, cols: ['seq', 'at', 'type', 'actor', 'ref', 'data', 'prev', 'hash'] };
  }
  if (type === 'blocked') {
    const rows = transactions(state).filter((t) => ['denied', 'rejected'].includes(t.status)).map((t) => ({ ...t, amount: fmt(t.amountCents) }));
    return { name: 'blocked-requests', rows, cols: ['id', 'kind', 'at', 'status', 'amount', 'party', 'category', 'actor', 'decidedBy', 'risk', 'note'] };
  }
  if (type === 'security') {
    return { name: 'security-log', rows: (state.secEvents || []).map((e) => ({ ...e, detail: JSON.stringify(e.detail || {}) })), cols: ['at', 'type', 'ip', 'detail'] };
  }
  const rows = transactions(state).map((t) => ({ ...t, amount: fmt(t.amountCents), agent: state.mandates[t.mandateId]?.agent || '' }));
  void now;
  return { name: 'transactions', rows, cols: ['id', 'kind', 'at', 'status', 'amount', 'party', 'category', 'actor', 'agent', 'verdict', 'decidedBy', 'risk', 'note'] };
}

/** Everything needed to prove why one item was decided the way it was. */
export function proofFor(state, ref) {
  const item = state.requests[ref] || state.escrows[ref] || state.orders[ref] || state.refunds[ref] || state.mandates[ref];
  const entries = state.ledger.filter((e) => e.ref === ref);
  if (!item && !entries.length) return null;
  const { agentTokenHash, ...safe } = item || {};
  void agentTokenHash;
  return { ref, item: safe, entries: entries.map((e) => ({ ...e, actor: actorOf(e) })), headHash: state.ledger.at(-1)?.hash, note: 'Each entry hash = SHA-256(prev hash + canonical entry). Re-run the chain from entry 1 to verify.' };
}
