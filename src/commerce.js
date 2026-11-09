import { newId } from './store.js';
import { evaluate, strictest } from './policy.js';
import { fmt, toCents } from './money.js';
import { HttpError } from './errors.js';

export const CATALOG = [
  { sku: 'data-pack', name: 'Sentiment dataset (12k labelled rows)', category: 'data', priceCents: 1800, digital: true },
  { sku: 'gpu-credits', name: 'GPU compute credits (64 USD pack)', category: 'software', priceCents: 6400, digital: true },
  { sku: 'api-licence', name: 'Embeddings API licence (monthly)', category: 'software', priceCents: 2900, digital: true },
  { sku: 'market-report', name: 'Market research report Q4', category: 'research', priceCents: 4900, digital: true },
  { sku: 'logo-design', name: 'Logo design (3 concepts)', category: 'design', priceCents: 12000, digital: false },
  { sku: 'copywriting', name: 'Landing-page copywriting', category: 'writing', priceCents: 8000, digital: false },
];

const REFUND_WINDOW_MS = 30 * 86_400_000;
const AUTO_REFUND_MAX = 5000; // $50
const iso = (t) => new Date(t).toISOString();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Merchant side of the platform: a PayPal-checkout storefront (humans AND governed agents can buy),
 * plus AI-triaged refunds. Prices come from the server-side catalog — a client or agent can never set a price.
 * Public methods take the engine's serial lock; underscore methods assume it is already held.
 */
export class Commerce {
  constructor(engine) { this.e = engine; }

  get state() { return this.e.state; }
  get merchantEmail() { return this.e.config.paypal.payeeEmail || this.e.config.merchantEmail || 'shop@merchant.example'; }

  product(sku) {
    const p = CATALOG.find((x) => x.sku === sku);
    if (!p) throw new HttpError(404, 'unknown product');
    return p;
  }

  // ------------------------------------------------------------------ orders
  createOrder({ sku, qty = 1, customerEmail, mandateId = null }) {
    return this.e.serial(async () => {
      const p = this.product(sku);
      const q = Number(qty);
      if (!Number.isInteger(q) || q < 1 || q > 10) throw new HttpError(400, 'quantity must be 1-10');
      const email = String(customerEmail || '').trim().toLowerCase();
      if (!EMAIL.test(email) && !mandateId) throw new HttpError(400, 'a valid customer email is required');
      if (mandateId) this.e.meterUse();
      const order = {
        id: newId('ord'), kind: 'order', mandateId, customerEmail: email || `agent:${mandateId}`, items: [{ sku: p.sku, name: p.name, qty: q, unitCents: p.priceCents }],
        totalCents: p.priceCents * q, amountCents: p.priceCents * q, currency: 'USD', digital: p.digital, category: p.category, payee: this.merchantEmail,
        purpose: `Buy ${q}× ${p.name}`, evidence: '', refundedCents: 0, status: 'evaluating', createdAt: iso(this.e.now()),
      };
      this.state.orders[order.id] = order;
      this.e.log('order.created', order.id, { sku, qty: q, total: fmt(order.totalCents), source: mandateId ? 'agent' : 'storefront' });
      if (mandateId) {
        const mandate = this.e.mandate(mandateId);
        await this.e.decide(order, mandate, { kind: 'order' });
        if (order.status !== 'approved_pending_execution') return order;
      }
      await this._place(order);
      return order;
    });
  }

  async _place(order) {
    try {
      const o = await this.e.paypal.createOrder({ amountCents: order.totalCents, currency: order.currency, description: order.purpose, customId: order.id, requestId: order.id, intent: 'CAPTURE' });
      order.paypal = { orderId: o.id, approveUrl: o.approveUrl, mode: this.e.paypal.mode };
      order.status = 'awaiting_buyer';
      this.e.log('order.paypal_created', order.id, { paypalOrderId: o.id, intent: 'CAPTURE' });
    } catch (err) {
      order.status = 'failed';
      order.error = err.message;
      this.e.log('order.failed', order.id, { error: err.message });
    }
  }

  /** Buyer approved at PayPal (live) — or we click "Pay" for the sandbox buyer (simulator) — then capture. */
  payOrder(id) {
    return this.e.serial(() => this._pay(id));
  }

  async _pay(id) {
    const order = this.order(id);
    if (order.status === 'paid') return order;
    if (order.status !== 'awaiting_buyer') throw new HttpError(409, `order is ${order.status}`);
    if (this.e.paypal.simulateBuyerApproval) await this.e.paypal.simulateBuyerApproval(order.paypal.orderId);
    const po = await this.e.paypal.getOrder(order.paypal.orderId);
    if (!['APPROVED', 'COMPLETED'].includes(po.status)) throw new HttpError(409, `buyer has not approved the PayPal order yet (status ${po.status})`);
    try {
      const cap = await this.e.paypal.captureOrder(order.paypal.orderId);
      order.status = 'paid';
      order.paidAt = iso(this.e.now());
      order.captureId = cap.captureId;
      this.e.log('order.paid', id, { captureId: cap.captureId, total: fmt(order.totalCents), by: order.mandateId ? 'agent' : 'customer' });
    } catch (err) {
      order.status = 'failed';
      order.error = err.message;
      this.e.log('order.capture_failed', id, { error: err.message });
    }
    return order;
  }

  order(id) {
    const o = this.state.orders[id];
    if (!o) throw new HttpError(404, 'order not found');
    return o;
  }

  /** Human approves an agent purchase that needed approval. */
  async _approveOrder(id, by) {
    const order = this.order(id);
    if (order.status !== 'pending_approval') throw new HttpError(409, `order is ${order.status}, not pending approval`);
    const re = evaluate({ mandate: this.e.mandate(order.mandateId), request: order, state: this.state, secret: this.e.config.mandateSecret, now: this.e.now(), ignoreEscalations: true });
    this.e.log('order.human_approved', id, { by, recheck: re.verdict });
    if (re.verdict === 'deny') { order.status = 'denied'; return order; }
    await this._place(order);
    return order;
  }

  // ------------------------------------------------------------------ refunds
  requestRefund(orderId, { reason, amount, requester = 'customer' }) {
    return this.e.serial(async () => {
      const order = this.order(orderId);
      if (!['paid', 'partially_refunded'].includes(order.status)) throw new HttpError(409, `order is ${order.status}; only paid orders can be refunded`);
      const remaining = order.totalCents - order.refundedCents;
      let amountCents;
      try { amountCents = amount === undefined || amount === '' ? remaining : toCents(amount); } catch (err) { throw new HttpError(400, err.message); }
      if (Object.values(this.state.refunds).some((r) => r.orderId === orderId && ['pending_approval', 'evaluating'].includes(r.status))) throw new HttpError(409, 'a refund is already open for this order');
      const rfd = { id: newId('rfd'), kind: 'refund', orderId, requester, reason: String(reason || '').slice(0, 500), amountCents, currency: order.currency, status: 'evaluating', createdAt: iso(this.e.now()) };
      this.state.refunds[rfd.id] = rfd;
      this.e.log('refund.requested', rfd.id, { orderId, amount: fmt(amountCents), requester });

      const checks = [
        { id: 'order_paid', label: 'Order was paid', pass: true, severity: 'deny' },
        { id: 'window', label: 'Within 30-day refund window', pass: this.e.now() - Date.parse(order.paidAt) <= REFUND_WINDOW_MS, severity: 'deny' },
        { id: 'amount', label: 'Amount ≤ refundable balance', pass: amountCents > 0 && amountCents <= remaining, severity: 'deny', detail: `${fmt(amountCents)} ≤ ${fmt(remaining)}` },
        { id: 'auto_limit', label: `Within auto-refund limit (${fmt(AUTO_REFUND_MAX)})`, pass: amountCents <= AUTO_REFUND_MAX, severity: 'escalate' },
      ];
      const policy = { verdict: checks.some((c) => !c.pass && c.severity === 'deny') ? 'deny' : checks.some((c) => !c.pass) ? 'escalate' : 'allow', checks };
      const priorRefunds = Object.values(this.state.refunds).filter((r) => r.id !== rfd.id && r.status === 'refunded' && this.state.orders[r.orderId]?.customerEmail === order.customerEmail).length;
      const ai = await this.e.ai.triageRefund({ order, reason: rfd.reason, amountCents, history: priorRefunds });
      const final = strictest(policy.verdict, ai.recommendation);
      rfd.decision = { policy, ai, final, decidedBy: final === 'allow' ? 'both' : policy.verdict === final ? 'policy' : 'ai' };
      this.e.log('refund.decision', rfd.id, { final, decidedBy: rfd.decision.decidedBy, aiRisk: ai.risk, aiRecommendation: ai.recommendation, rationale: ai.rationale });
      if (final === 'deny') rfd.status = 'denied';
      else if (final === 'escalate') rfd.status = 'pending_approval';
      else await this._executeRefund(rfd, order);
      return rfd;
    });
  }

  async _executeRefund(rfd, order) {
    try {
      const out = await this.e.paypal.refundCapture(order.captureId, { amountCents: rfd.amountCents, currency: order.currency });
      rfd.status = 'refunded';
      rfd.paypal = { refundId: out.refundId, status: out.status, mode: this.e.paypal.mode };
      order.refundedCents += rfd.amountCents;
      order.status = order.refundedCents >= order.totalCents ? 'refunded' : 'partially_refunded';
      this.e.log('refund.executed', rfd.id, { orderId: order.id, amount: fmt(rfd.amountCents), paypalRefundId: out.refundId });
    } catch (err) {
      rfd.status = 'failed';
      rfd.error = err.message;
      this.e.log('refund.failed', rfd.id, { error: err.message });
    }
  }

  async _approveRefund(id, by) {
    const rfd = this.state.refunds[id];
    if (!rfd) throw new HttpError(404, 'refund not found');
    if (rfd.status !== 'pending_approval') throw new HttpError(409, `refund is ${rfd.status}, not pending approval`);
    const order = this.order(rfd.orderId);
    if (rfd.amountCents > order.totalCents - order.refundedCents) { rfd.status = 'denied'; return rfd; }
    this.e.log('refund.human_approved', id, { by });
    await this._executeRefund(rfd, order);
    return rfd;
  }
}
