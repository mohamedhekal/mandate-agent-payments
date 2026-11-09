import crypto from 'node:crypto';
import { PayPalError } from './live.js';

const pid = (n = 17) => crypto.randomBytes(n).toString('hex').toUpperCase().slice(0, n);
const fail = (status, name, issue, message) => new PayPalError(status, { name, message, details: [{ issue }], debug_id: pid(13).toLowerCase() }, 'simulated call');

/**
 * Local stand-in for the PayPal SANDBOX so judges can run everything with zero credentials.
 * It mirrors the real API's state machine (Orders v2 authorize -> partial captures -> void, Payouts)
 * and its error shapes, behind the exact same interface as PayPalLive.
 */
export class PayPalSimulator {
  mode = 'simulated';

  constructor({ publicUrl = 'http://localhost:8787' } = {}) {
    this.publicUrl = publicUrl;
    this.orders = new Map();
    this.auths = new Map();
    this.captures = new Map();
    this.payouts = new Map();
  }

  async createPayout({ batchId, items }) {
    if (this.payouts.has(batchId)) return { batchId: this.payouts.get(batchId).id, status: 'SUCCESS' }; // idempotent
    for (const i of items) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.receiver)) throw fail(400, 'VALIDATION_ERROR', 'RECEIVER_INVALID', `Invalid receiver ${i.receiver}`);
      if (!(i.amountCents > 0)) throw fail(400, 'VALIDATION_ERROR', 'AMOUNT_INVALID', 'Amount must be positive');
    }
    const id = pid(13);
    this.payouts.set(batchId, { id, items, status: 'SUCCESS' });
    this.payouts.set(id, this.payouts.get(batchId));
    return { batchId: id, status: 'SUCCESS' };
  }

  async getPayout(id) {
    const p = this.payouts.get(id);
    if (!p) throw fail(404, 'INVALID_RESOURCE_ID', 'INVALID_RESOURCE_ID', 'Payout not found');
    return { batchId: id, status: p.status, items: p.items.map((i) => ({ status: 'SUCCESS', receiver: i.receiver })) };
  }

  async createOrder({ amountCents, currency, description, customId, intent = 'AUTHORIZE' }) {
    if (!(amountCents > 0)) throw fail(422, 'UNPROCESSABLE_ENTITY', 'INVALID_PARAMETER_VALUE', 'amount.value');
    const id = pid(17);
    this.orders.set(id, { id, amountCents, currency, description, customId, intent, status: 'CREATED', authorizationId: null });
    return { id, status: 'CREATED', approveUrl: `${this.publicUrl}/#simulated-paypal-approval-${id}` };
  }

  /** Simulation-only: the sandbox buyer clicks "Pay Now" on PayPal. */
  async simulateBuyerApproval(id) {
    const o = this.orders.get(id);
    if (!o) throw fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'order');
    o.status = 'APPROVED';
    return { id, status: o.status };
  }

  async getOrder(id) {
    const o = this.orders.get(id);
    if (!o) throw fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'order');
    return { id, status: o.status };
  }

  async captureOrder(id) {
    const o = this.orders.get(id);
    if (!o) throw fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'order');
    if (o.status === 'COMPLETED') return { captureId: o.captureId, status: 'COMPLETED' };
    if (o.status !== 'APPROVED') throw fail(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED', 'Payer has not approved the order');
    const captureId = pid(17);
    o.status = 'COMPLETED';
    o.captureId = captureId;
    this.captures.set(captureId, { id: captureId, authId: null, amountCents: o.amountCents, refundedCents: 0, currency: o.currency });
    return { captureId, status: 'COMPLETED' };
  }

  async createSubscription({ planId, customId }) {
    const id = `I-${pid(12)}`;
    this.subs = this.subs || new Map();
    this.subs.set(id, { id, planId, customId, status: 'APPROVAL_PENDING' });
    return { id, status: 'APPROVAL_PENDING', approveUrl: `${this.publicUrl}/#simulated-subscription-${id}` };
  }

  async simulateSubscriptionApproval(id) {
    const s = this.subs?.get(id);
    if (!s) throw fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'subscription');
    s.status = 'ACTIVE';
    return { id, status: s.status, planId: s.planId };
  }

  async getSubscription(id) {
    const s = this.subs?.get(id);
    if (!s) throw fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'subscription');
    return { id, status: s.status, planId: s.planId };
  }

  async authorizeOrder(id) {
    const o = this.orders.get(id);
    if (!o) throw fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'order');
    if (o.status === 'AUTHORIZED') return { authorizationId: o.authorizationId, status: 'CREATED' };
    if (o.status !== 'APPROVED') throw fail(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED', 'Payer has not approved the order');
    const authorizationId = pid(17);
    o.status = 'AUTHORIZED';
    o.authorizationId = authorizationId;
    this.auths.set(authorizationId, { id: authorizationId, orderId: id, totalCents: o.amountCents, capturedCents: 0, currency: o.currency, status: 'CREATED' });
    return { authorizationId, status: 'CREATED' };
  }

  async captureAuthorization(authId, { amountCents, currency, finalCapture }) {
    const a = this.auths.get(authId);
    if (!a) throw fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'authorization');
    if (a.status === 'VOIDED') throw fail(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_VOIDED', 'Authorization voided');
    if (a.status === 'CAPTURED') throw fail(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_ALREADY_CAPTURED', 'Authorization already captured');
    if (currency !== a.currency) throw fail(422, 'UNPROCESSABLE_ENTITY', 'CURRENCY_MISMATCH', 'currency');
    if (a.capturedCents + amountCents > a.totalCents) throw fail(422, 'UNPROCESSABLE_ENTITY', 'CAPTURE_AMOUNT_EXCEEDS_AUTHORIZATION', 'Amount exceeds authorization');
    a.capturedCents += amountCents;
    a.status = finalCapture || a.capturedCents === a.totalCents ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
    const captureId = pid(17);
    this.captures.set(captureId, { id: captureId, authId, amountCents, refundedCents: 0, currency });
    return { captureId, status: 'COMPLETED' };
  }

  async voidAuthorization(authId) {
    const a = this.auths.get(authId);
    if (!a) throw fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'authorization');
    if (a.status === 'CAPTURED') throw fail(422, 'UNPROCESSABLE_ENTITY', 'PREVIOUSLY_CAPTURED', 'Authorization fully captured');
    a.status = 'VOIDED';
    return { status: 'VOIDED' };
  }

  async refundCapture(captureId, { amountCents, currency }) {
    const c = this.captures.get(captureId);
    if (!c) throw fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'capture');
    const amt = amountCents ?? c.amountCents - c.refundedCents;
    if (c.refundedCents + amt > c.amountCents) throw fail(422, 'UNPROCESSABLE_ENTITY', 'CAPTURE_FULLY_REFUNDED', 'Refund exceeds capture');
    c.refundedCents += amt;
    return { refundId: pid(17), status: 'COMPLETED', currency };
  }
}
