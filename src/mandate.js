import crypto from 'node:crypto';
import { canonical, newId, sha256 } from './store.js';
import { toCents } from './money.js';

export const PERIODS = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, total: Infinity };
export const CATEGORIES = ['data', 'software', 'research', 'design', 'writing', 'marketing', 'travel', 'contractor', 'other'];

const SIGNED_FIELDS = ['id', 'owner', 'agent', 'currency', 'budgetCents', 'period', 'perTxCents', 'approvalOverCents', 'categories', 'payees', 'maxPerHour', 'createdAt', 'expiresAt'];

const sign = (core, secret) => crypto.createHmac('sha256', secret).update(canonical(core)).digest('hex');
const core = (m) => Object.fromEntries(SIGNED_FIELDS.map((k) => [k, m[k]]));

export function normalizePayee(p) {
  const s = String(p).trim().toLowerCase();
  if (!/^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/.test(s)) throw new Error(`invalid payee "${p}" (use name@host or @host)`);
  return s;
}

/** Validates & normalises human input into a signed mandate. Throws on bad input. */
export function createMandate(input, { secret, now = Date.now() }) {
  const owner = String(input.owner || '').trim() || 'owner';
  const agent = String(input.agent || '').trim();
  if (!agent) throw new Error('agent name is required');
  const currency = String(input.currency || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('invalid currency');
  const budgetCents = input.budgetCents ?? toCents(input.budget);
  const perTxCents = input.perTxCents ?? (input.perTx !== undefined ? toCents(input.perTx) : budgetCents);
  const approvalOverCents = input.approvalOverCents ?? (input.approvalOver !== undefined ? toCents(input.approvalOver) : perTxCents);
  if (!(budgetCents > 0)) throw new Error('budget must be > 0');
  if (perTxCents > budgetCents) throw new Error('per-transaction limit cannot exceed the budget');
  if (approvalOverCents > perTxCents) throw new Error('approval threshold cannot exceed the per-transaction limit');
  const period = input.period || 'week';
  if (!(period in PERIODS)) throw new Error(`period must be one of ${Object.keys(PERIODS).join(', ')}`);
  const categories = [...new Set((input.categories || []).map((c) => String(c).toLowerCase()))];
  for (const c of categories) if (!CATEGORIES.includes(c)) throw new Error(`unknown category "${c}"`);
  if (!categories.length) throw new Error('at least one allowed category is required');
  const payees = [...new Set((input.payees || []).map(normalizePayee))];
  const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : new Date(now + 30 * 86_400_000).toISOString();
  if (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now) throw new Error('expiry must be in the future');
  const maxPerHour = Number(input.maxPerHour ?? 10);
  const id = newId('mnd');
  const body = { id, owner, agent, currency, budgetCents, period, perTxCents, approvalOverCents, categories, payees, maxPerHour, createdAt: new Date(now).toISOString(), expiresAt };
  const agentToken = `mat_${crypto.randomBytes(16).toString('hex')}`;
  return {
    mandate: { ...body, signature: sign(body, secret), agentTokenHash: sha256(agentToken), revokedAt: null },
    agentToken, // shown once, never stored in clear
  };
}

export const verifyMandate = (m, secret) => {
  const a = Buffer.from(sign(core(m), secret));
  const b = Buffer.from(String(m.signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export const tokenMatches = (m, token) => !!token && sha256(token) === m.agentTokenHash;

export const publicMandate = ({ agentTokenHash, ...rest }) => rest;

/** Money already committed in the mandate's rolling window (executed payments + active escrow exposure). */
export function usage(mandate, state, now = Date.now()) {
  const win = PERIODS[mandate.period];
  const since = win === Infinity ? 0 : now - win;
  let spent = 0;
  for (const r of Object.values(state.requests)) {
    if (r.mandateId === mandate.id && r.status === 'executed' && Date.parse(r.executedAt) >= since) spent += r.amountCents;
  }
  for (const e of Object.values(state.escrows)) {
    if (e.mandateId === mandate.id && Date.parse(e.fundedAt || e.createdAt) >= since) spent += e.committedCents || 0;
  }
  for (const o of Object.values(state.orders || {})) {
    if (o.mandateId === mandate.id && ['paid', 'partially_refunded', 'refunded'].includes(o.status) && Date.parse(o.paidAt) >= since) spent += o.totalCents - o.refundedCents;
  }
  return { spentCents: spent, remainingCents: Math.max(0, mandate.budgetCents - spent) };
}
