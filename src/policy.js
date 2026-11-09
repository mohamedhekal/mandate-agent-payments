import { usage, verifyMandate } from './mandate.js';
import { fmt } from './money.js';

const DUP_WINDOW_MS = 15 * 60_000;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

export function payeeAllowed(allowlist, payee) {
  const p = String(payee).toLowerCase();
  return allowlist.some((a) => (a.startsWith('@') ? p.endsWith(a) : p === a));
}

/**
 * Deterministic hard rules. Pure function: (mandate, request, state, now) -> verdict + per-rule evidence.
 * The AI reviewer can only make the final answer STRICTER than this; it can never override a deny.
 *   verdict: 'allow' | 'escalate' (needs a human) | 'deny'
 */
export function evaluate({ mandate, request, state, secret, now = Date.now(), ignoreEscalations = false }) {
  const checks = [];
  const add = (id, label, pass, severity, detail) => checks.push({ id, label, pass, severity, detail });
  const cur = mandate.currency;

  add('signature', 'Mandate signature valid', verifyMandate(mandate, secret), 'deny', 'HMAC-SHA256 over the canonical mandate');
  add('frozen', 'Agents not frozen (kill switch)', !state.tenant?.frozen, 'deny', state.tenant?.frozen ? `frozen ${state.tenant.frozen.at} by ${state.tenant.frozen.by}` : 'running');
  add('active', 'Mandate not revoked', !mandate.revokedAt, 'deny', mandate.revokedAt ? `revoked ${mandate.revokedAt}` : 'active');
  add('expiry', 'Mandate not expired', Date.parse(mandate.expiresAt) > now, 'deny', `expires ${mandate.expiresAt}`);
  add('currency', 'Currency matches', request.currency === cur, 'deny', `${request.currency} vs ${cur}`);
  add('amount', 'Amount is a positive value', Number.isInteger(request.amountCents) && request.amountCents > 0, 'deny', fmt(request.amountCents || 0, cur));
  add('per_tx', 'Within per-transaction limit', request.amountCents <= mandate.perTxCents, 'deny', `${fmt(request.amountCents, cur)} ≤ ${fmt(mandate.perTxCents, cur)}`);

  const u = usage(mandate, state, now);
  add('budget', `Within ${mandate.period} budget`, request.amountCents <= u.remainingCents, 'deny', `${fmt(request.amountCents, cur)} ≤ ${fmt(u.remainingCents, cur)} remaining`);
  add('category', 'Category allowed', mandate.categories.includes(request.category), 'deny', `"${request.category}" in [${mandate.categories.join(', ')}]`);

  if (mandate.payees.length) {
    add('allowlist', 'Payee on allowlist', payeeAllowed(mandate.payees, request.payee), 'deny', request.payee);
  } else {
    const known = Object.values(state.requests).some((r) => r.mandateId === mandate.id && r.status === 'executed' && r.payee === request.payee);
    add('known_payee', 'Payee previously paid', known, 'escalate', known ? 'seen before' : 'first payment to this payee');
  }

  const hourAgo = now - 3_600_000;
  const recent = Object.values(state.requests).filter((r) => r.mandateId === mandate.id && r.id !== request.id && Date.parse(r.createdAt) >= hourAgo && r.status !== 'denied');
  add('velocity', 'Request rate normal', recent.length < mandate.maxPerHour, 'deny', `${recent.length}/${mandate.maxPerHour} per hour`);

  const dup = Object.values(state.requests).find(
    (r) => r.mandateId === mandate.id && r.id !== request.id && ['executed', 'pending_approval'].includes(r.status) && r.payee === request.payee && r.amountCents === request.amountCents && norm(r.purpose) === norm(request.purpose) && now - Date.parse(r.createdAt) < DUP_WINDOW_MS,
  );
  add('duplicate', 'Not a duplicate', !dup, 'deny', dup ? `matches ${dup.id}` : 'unique');

  add('human_threshold', 'Below human-approval threshold', request.amountCents <= mandate.approvalOverCents, 'escalate', `${fmt(request.amountCents, cur)} vs threshold ${fmt(mandate.approvalOverCents, cur)}`);

  const failed = checks.filter((c) => !c.pass);
  let verdict = 'allow';
  if (failed.some((c) => c.severity === 'deny')) verdict = 'deny';
  else if (failed.length && !ignoreEscalations) verdict = 'escalate';
  return { verdict, checks, usage: u };
}

const RANK = { allow: 0, escalate: 1, deny: 2 };
/** Combine verdicts: the strictest wins (AI can tighten, never loosen). */
export const strictest = (...vs) => vs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'allow');
