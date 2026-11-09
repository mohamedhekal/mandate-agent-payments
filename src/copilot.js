import { fmt } from './money.js';
import { usage } from './mandate.js';
import { CATALOG } from './commerce.js';

const DAY = 86_400_000;

/** Pure aggregation over state → numbers the dashboard and the AI copilot can both use. No PII leaves this function. */
export function computeMetrics(state, now) {
  const orders = Object.values(state.orders);
  const paid = orders.filter((o) => ['paid', 'partially_refunded', 'refunded'].includes(o.status));
  const grossCents = paid.reduce((s, o) => s + o.totalCents, 0);
  const refundedCents = paid.reduce((s, o) => s + o.refundedCents, 0);
  const requests = Object.values(state.requests);
  const executed = requests.filter((r) => r.status === 'executed');
  const blocked = [...requests, ...Object.values(state.escrows), ...orders, ...Object.values(state.refunds)].filter((r) => r.status === 'denied');
  const aiBlocked = blocked.filter((r) => r.decision?.decidedBy === 'ai');
  const pending = [...requests, ...Object.values(state.escrows), ...orders, ...Object.values(state.refunds)].filter((r) => r.status === 'pending_approval');

  const byProduct = {};
  for (const o of paid) for (const i of o.items) byProduct[i.sku] = (byProduct[i.sku] || 0) + i.unitCents * i.qty;
  const topProducts = Object.entries(byProduct).sort((a, b) => b[1] - a[1]).map(([sku, cents]) => ({ sku, name: CATALOG.find((c) => c.sku === sku)?.name || sku, cents }));

  const series = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(now - (13 - i) * DAY).toISOString().slice(0, 10);
    return { day, cents: paid.filter((o) => o.paidAt?.slice(0, 10) === day).reduce((s, o) => s + o.totalCents, 0) };
  });

  const mandates = Object.values(state.mandates).filter((m) => !m.revokedAt).map((m) => {
    const u = usage(m, state, now);
    return { id: m.id, agent: m.agent, budgetCents: m.budgetCents, spentCents: u.spentCents, pct: Math.round((u.spentCents / m.budgetCents) * 100) };
  });

  return {
    revenueCents: grossCents - refundedCents, grossCents, refundedCents,
    orders: paid.length, avgOrderCents: paid.length ? Math.round(grossCents / paid.length) : 0,
    refundRatePct: grossCents ? Math.round((refundedCents / grossCents) * 1000) / 10 : 0,
    agentSpendCents: executed.reduce((s, r) => s + r.amountCents, 0) + Object.values(state.escrows).reduce((s, e) => s + (e.capturedCents || 0), 0),
    blockedCount: blocked.length, blockedValueCents: blocked.reduce((s, r) => s + (r.amountCents || r.totalCents || 0), 0), aiBlockedCount: aiBlocked.length,
    pendingApprovals: pending.length, topProducts, series, mandates,
  };
}

export function insights(m) {
  const out = [];
  if (m.aiBlockedCount) out.push({ level: 'good', title: `AI stopped ${m.aiBlockedCount} manipulated request${m.aiBlockedCount > 1 ? 's' : ''}`, detail: `${fmt(m.blockedValueCents)} of attempted spend blocked in total.` });
  if (m.pendingApprovals) out.push({ level: 'warn', title: `${m.pendingApprovals} item${m.pendingApprovals > 1 ? 's' : ''} waiting for your approval`, detail: 'Agents and customers are blocked until you decide.' });
  if (m.refundRatePct > 15) out.push({ level: 'bad', title: `Refund rate is ${m.refundRatePct}%`, detail: 'Above the 15% alert line — check product quality or abuse patterns.' });
  for (const x of m.mandates.filter((x) => x.pct >= 80)) out.push({ level: 'warn', title: `${x.agent} has used ${x.pct}% of its budget`, detail: 'Raise the mandate or expect denials.' });
  const top = m.topProducts[0];
  if (top && m.grossCents && top.cents / m.grossCents > 0.5 && m.orders > 1) out.push({ level: 'info', title: `${top.name} is ${Math.round((top.cents / m.grossCents) * 100)}% of revenue`, detail: 'Revenue is concentrated in one product.' });
  if (!out.length) out.push({ level: 'good', title: 'All quiet', detail: 'No risks or approvals pending.' });
  return out;
}

/** Offline copilot: intent-match the question against the metrics. The Claude path gets the same metrics. */
export function answerOffline(q, m) {
  const t = q.toLowerCase();
  if (/refund/.test(t)) return `Refunded ${fmt(m.refundedCents)} of ${fmt(m.grossCents)} gross (${m.refundRatePct}% refund rate).`;
  if (/block|fraud|attack|inject|risk|prevent/.test(t)) return `${m.blockedCount} requests were blocked (${fmt(m.blockedValueCents)} attempted); ${m.aiBlockedCount} of them were caught by the AI layer rather than the hard rules.`;
  if (/budget|agent|spend/.test(t)) return m.mandates.length ? m.mandates.map((x) => `${x.agent}: ${fmt(x.spentCents)} of ${fmt(x.budgetCents)} (${x.pct}%)`).join('; ') + `. Total agent spend ${fmt(m.agentSpendCents)}.` : 'No active mandates.';
  if (/top|best|product|sell/.test(t)) return m.topProducts.length ? `Top product: ${m.topProducts[0].name} (${fmt(m.topProducts[0].cents)}).` : 'No sales yet.';
  if (/pending|approv|wait/.test(t)) return `${m.pendingApprovals} item(s) await your approval.`;
  if (/revenue|sales|order|earn|money/.test(t)) return `Net revenue ${fmt(m.revenueCents)} from ${m.orders} paid orders (average ${fmt(m.avgOrderCents)}).`;
  return `Net revenue ${fmt(m.revenueCents)}, agent spend ${fmt(m.agentSpendCents)}, ${m.blockedCount} blocked, ${m.pendingApprovals} pending. Ask about revenue, refunds, agents, blocked requests or top products.`;
}
