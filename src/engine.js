import crypto from 'node:crypto';
import { newId, sha256 } from './store.js';
import { createMandate, publicMandate, tokenMatches, usage } from './mandate.js';
import { evaluate, strictest } from './policy.js';
import { fmt, toCents } from './money.js';
import { HttpError } from './errors.js';
import { Commerce } from './commerce.js';
import { PLANS, monthKey, usageOf } from './billing.js';
import { computeMetrics, insights, answerOffline } from './copilot.js';
import { trustScore, forecast } from './reports.js';

export { HttpError };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (s, n) => String(s ?? '').slice(0, n);

/**
 * The core: mandate -> policy (hard rules) -> AI review (judgment) -> human (if needed) -> PayPal.
 * All mutations are serialised through one queue so concurrent agents cannot race past a budget.
 */
export class Engine {
  constructor({ store, paypal, ai, config, now = () => Date.now() }) {
    Object.assign(this, { store, paypal, ai, config, now });
    this.queue = Promise.resolve();
    this.commerce = new Commerce(this);
  }

  get state() { return this.store.state; }

  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run.finally(() => this.store.save());
  }

  /** Count one governed request against the plan; 402 when the monthly quota is used up. */
  meterUse() {
    const t = this.state.tenant;
    const key = monthKey(this.now());
    const { plan, used } = usageOf(t, this.now());
    if (used >= plan.requestsPerMonth) throw new HttpError(402, `${plan.name} plan limit reached (${plan.requestsPerMonth} requests/month) — upgrade to continue`);
    t.meter[key] = used + 1;
  }

  log(type, ref, data) { return this.store.log(type, ref, data, this.now()); }

  // ---------------------------------------------------------------- mandates
  createMandate(input) {
    return this.serial(async () => {
      const active = Object.values(this.state.mandates).filter((m) => !m.revokedAt).length;
      const plan = PLANS[this.state.tenant.plan] || PLANS.free;
      if (active >= plan.agents) throw new HttpError(402, `${plan.name} plan allows ${plan.agents} active mandates — revoke one or upgrade`);
      let r;
      try { r = createMandate(input, { secret: this.config.mandateSecret, now: this.now() }); } catch (e) { throw new HttpError(400, e.message); }
      this.state.mandates[r.mandate.id] = r.mandate;
      this.log('mandate.created', r.mandate.id, { agent: r.mandate.agent, budget: fmt(r.mandate.budgetCents, r.mandate.currency), period: r.mandate.period, perTx: fmt(r.mandate.perTxCents), approvalOver: fmt(r.mandate.approvalOverCents), categories: r.mandate.categories, payees: r.mandate.payees, signature: r.mandate.signature.slice(0, 16) });
      return { mandate: this.mandateView(r.mandate), agentToken: r.agentToken };
    });
  }

  revokeMandate(id) {
    return this.serial(async () => {
      const m = this.mandate(id);
      m.revokedAt = new Date(this.now()).toISOString();
      this.log('mandate.revoked', id, {});
      return this.mandateView(m);
    });
  }

  /** Rotate an agent's token (invalidates the old one immediately). */
  rotateToken(id) {
    return this.serial(async () => {
      const m = this.mandate(id);
      const agentToken = `mat_${crypto.randomBytes(16).toString('hex')}`;
      m.agentTokenHash = sha256(agentToken);
      this.log('mandate.token_rotated', id, {});
      return { agentToken };
    });
  }

  mandate(id) {
    const m = this.state.mandates[id];
    if (!m) throw new HttpError(404, 'mandate not found');
    return m;
  }

  mandateByToken(token) {
    return Object.values(this.state.mandates).find((m) => tokenMatches(m, token)) || null;
  }

  mandateView(m) {
    return { ...publicMandate(m), ...usage(m, this.state, this.now()), trust: trustScore(this.state, m), forecast: forecast(this.state, m, this.now()) };
  }

  // ---------------------------------------------------------------- payments
  parseRequest(input) {
    const payee = String(input.payee || '').trim().toLowerCase();
    if (!EMAIL.test(payee)) throw new HttpError(400, 'payee must be a PayPal email address');
    let amountCents;
    try { amountCents = input.amountCents ?? toCents(input.amount); } catch (e) { throw new HttpError(400, e.message); }
    return {
      payee, amountCents,
      currency: String(input.currency || 'USD').toUpperCase(),
      category: String(input.category || 'other').toLowerCase(),
      purpose: clip(input.purpose, 500),
      evidence: clip(input.evidence, 4000),
    };
  }

  submitPayment(mandateId, input) {
    return this.serial(async () => {
      const mandate = this.mandate(mandateId);
      this.meterUse();
      const req = { id: newId('req'), kind: 'payment', mandateId, ...this.parseRequest(input), status: 'evaluating', createdAt: new Date(this.now()).toISOString() };
      if (!req.purpose.trim()) throw new HttpError(400, 'purpose is required');
      this.state.requests[req.id] = req;
      this.log('payment.requested', req.id, { mandateId, payee: req.payee, amount: fmt(req.amountCents, req.currency), category: req.category, purpose: req.purpose });
      await this.decide(req, mandate);
      if (req.status === 'approved_pending_execution') await this.execute(req, mandate);
      return req;
    });
  }

  /** Runs policy + AI and sets req.decision / req.status. Does NOT touch PayPal. */
  async decide(req, mandate, { kind = 'payment' } = {}) {
    const policy = evaluate({ mandate, request: req, state: this.state, secret: this.config.mandateSecret, now: this.now() });
    const ai = await this.ai.reviewRequest({ mandate, request: req, state: this.state }, { skipLLM: policy.verdict === 'deny' });
    const final = strictest(policy.verdict, ai.recommendation);
    const decidedBy = final === 'allow' ? 'both' : policy.verdict === final ? 'policy' : 'ai';
    req.decision = { policy, ai, final, decidedBy };
    req.status = final === 'allow' ? 'approved_pending_execution' : final === 'escalate' ? 'pending_approval' : 'denied';
    this.log(`${kind}.decision`, req.id, { final, decidedBy, policyVerdict: policy.verdict, failedChecks: policy.checks.filter((c) => !c.pass).map((c) => c.id), aiRecommendation: ai.recommendation, aiRisk: ai.risk, reviewers: ai.reviewers, rationale: ai.rationale });
  }

  async execute(req, mandate) {
    try {
      const out = await this.paypal.createPayout({
        batchId: req.id,
        items: [{ receiver: req.payee, amountCents: req.amountCents, currency: req.currency, note: `${req.purpose} (mandate ${mandate.id})`, itemId: req.id }],
      });
      req.status = 'executed';
      req.executedAt = new Date(this.now()).toISOString();
      req.paypal = { rail: 'payouts', batchId: out.batchId, status: out.status, mode: this.paypal.mode };
      this.log('payment.executed', req.id, { amount: fmt(req.amountCents, req.currency), payee: req.payee, paypalBatchId: out.batchId, mode: this.paypal.mode });
    } catch (e) {
      req.status = 'failed';
      req.error = e.message;
      this.log('payment.failed', req.id, { error: e.message, debugId: e.debugId });
    }
  }

  // ---------------------------------------------------------------- human approval queue
  approve(id, by = 'owner') {
    return this.serial(async () => {
      if (id.startsWith('esc_')) return this.approveEscrow(id, by);
      if (id.startsWith('ord_')) return this.commerce._approveOrder(id, by);
      if (id.startsWith('rfd_')) return this.commerce._approveRefund(id, by);
      const req = this.state.requests[id];
      if (!req) throw new HttpError(404, 'request not found');
      if (req.status !== 'pending_approval') throw new HttpError(409, `request is ${req.status}, not pending approval`);
      const mandate = this.mandate(req.mandateId);
      const re = evaluate({ mandate, request: req, state: this.state, secret: this.config.mandateSecret, now: this.now(), ignoreEscalations: true });
      this.log('payment.human_approved', id, { by, recheck: re.verdict });
      if (re.verdict === 'deny') {
        req.status = 'denied';
        req.decision.recheck = re;
        this.log('payment.denied_on_recheck', id, { failed: re.checks.filter((c) => !c.pass).map((c) => c.id) });
        return req;
      }
      req.approvedBy = by;
      await this.execute(req, mandate);
      return req;
    });
  }

  reject(id, by = 'owner') {
    return this.serial(async () => {
      const item = this.state.requests[id] || this.state.escrows[id] || this.state.orders[id] || this.state.refunds[id];
      if (!item) throw new HttpError(404, 'not found');
      if (item.status !== 'pending_approval') throw new HttpError(409, `item is ${item.status}, not pending approval`);
      item.status = 'rejected';
      this.log('human.rejected', id, { by });
      return item;
    });
  }

  // ---------------------------------------------------------------- escrow
  createEscrow(mandateId, input) {
    return this.serial(async () => {
      const mandate = this.mandate(mandateId);
      this.meterUse();
      const base = this.parseRequest({ ...input, amountCents: 1 }); // validates payee/category
      const ms = (input.milestones || []).map((m, i) => {
        let amountCents;
        try { amountCents = m.amountCents ?? toCents(m.amount); } catch (e) { throw new HttpError(400, `milestone ${i + 1}: ${e.message}`); }
        const criteria = (m.criteria || []).map((c) => clip(c, 200)).filter(Boolean);
        if (!m.name || !criteria.length) throw new HttpError(400, `milestone ${i + 1} needs a name and at least one acceptance criterion`);
        return { id: `m${i + 1}`, name: clip(m.name, 80), amountCents, criteria, status: 'pending', attempts: [] };
      });
      if (!ms.length || ms.length > 10) throw new HttpError(400, '1-10 milestones required');
      const totalCents = ms.reduce((s, m) => s + m.amountCents, 0);
      const title = clip(input.title, 120);
      if (!title) throw new HttpError(400, 'title is required');
      const esc = { id: newId('esc'), kind: 'escrow', mandateId, payee: base.payee, title, category: base.category, currency: base.currency, totalCents, amountCents: totalCents, committedCents: 0, capturedCents: 0, purpose: `${title}. ${clip(input.purpose, 300)}`, evidence: base.evidence, milestones: ms, status: 'evaluating', createdAt: new Date(this.now()).toISOString() };
      this.state.escrows[esc.id] = esc;
      this.log('escrow.requested', esc.id, { mandateId, payee: esc.payee, total: fmt(totalCents, esc.currency), milestones: ms.map((m) => `${m.name}: ${fmt(m.amountCents)}`) });
      await this.decide(esc, mandate, { kind: 'escrow' });
      if (esc.status === 'approved_pending_execution') await this.openEscrow(esc);
      return esc;
    });
  }

  async openEscrow(esc) {
    try {
      const order = await this.paypal.createOrder({ amountCents: esc.totalCents, currency: esc.currency, description: `Escrow: ${esc.title}`, customId: esc.id, requestId: esc.id });
      esc.paypal = { orderId: order.id, approveUrl: order.approveUrl, mode: this.paypal.mode };
      esc.status = 'awaiting_funding';
      this.log('escrow.order_created', esc.id, { orderId: order.id, intent: 'AUTHORIZE', mode: this.paypal.mode });
    } catch (e) {
      esc.status = 'failed';
      esc.error = e.message;
      this.log('escrow.failed', esc.id, { error: e.message });
    }
  }

  async approveEscrow(id, by) {
    const esc = this.state.escrows[id];
    if (esc.status !== 'pending_approval') throw new HttpError(409, `escrow is ${esc.status}, not pending approval`);
    const mandate = this.mandate(esc.mandateId);
    const re = evaluate({ mandate, request: esc, state: this.state, secret: this.config.mandateSecret, now: this.now(), ignoreEscalations: true });
    this.log('escrow.human_approved', id, { by, recheck: re.verdict });
    if (re.verdict === 'deny') { esc.status = 'denied'; return esc; }
    await this.openEscrow(esc);
    return esc;
  }

  /** Buyer approval is a real PayPal checkout. In the simulator we click "Pay Now" for the sandbox buyer. */
  fundEscrow(id) {
    return this.serial(async () => {
      const esc = this.escrow(id);
      if (esc.status !== 'awaiting_funding') throw new HttpError(409, `escrow is ${esc.status}`);
      const mandate = this.mandate(esc.mandateId);
      const u = usage(mandate, this.state, this.now());
      if (esc.totalCents > u.remainingCents) throw new HttpError(409, `budget changed: only ${fmt(u.remainingCents)} remaining`);
      if (this.paypal.simulateBuyerApproval) await this.paypal.simulateBuyerApproval(esc.paypal.orderId);
      const order = await this.paypal.getOrder(esc.paypal.orderId);
      if (!['APPROVED', 'AUTHORIZED'].includes(order.status)) throw new HttpError(409, `buyer has not approved the PayPal order yet (status ${order.status})`);
      const auth = await this.paypal.authorizeOrder(esc.paypal.orderId);
      esc.paypal.authorizationId = auth.authorizationId;
      esc.status = 'funded';
      esc.fundedAt = new Date(this.now()).toISOString();
      esc.committedCents = esc.totalCents;
      this.log('escrow.funded', id, { authorizationId: auth.authorizationId, held: fmt(esc.totalCents, esc.currency) });
      return esc;
    });
  }

  escrow(id) {
    const e = this.state.escrows[id];
    if (!e) throw new HttpError(404, 'escrow not found');
    return e;
  }

  submitDeliverable(escrowId, milestoneId, deliverable) {
    return this.serial(async () => {
      const esc = this.escrow(escrowId);
      const m = esc.milestones.find((x) => x.id === milestoneId);
      if (!m) throw new HttpError(404, 'milestone not found');
      if (esc.status !== 'funded') throw new HttpError(409, `escrow is ${esc.status}; it must be funded`);
      if (m.status !== 'pending') throw new HttpError(409, `milestone is ${m.status}`);
      const text = clip(deliverable, 8000);
      const verdict = await this.ai.verifyDeliverable({ criteria: m.criteria, deliverable: text, title: m.name });
      m.attempts.push({ at: new Date(this.now()).toISOString(), excerpt: clip(text, 280), verdict });
      this.log('escrow.deliverable_checked', escrowId, { milestone: m.id, recommendation: verdict.recommendation, score: verdict.score, flags: verdict.flags.map((f) => f.id), reviewers: verdict.reviewers });
      if (verdict.recommendation === 'release') await this.capture(esc, m, 'ai-verifier');
      else if (verdict.recommendation === 'partial') { m.status = 'review'; this.log('escrow.needs_human', escrowId, { milestone: m.id }); }
      return esc;
    });
  }

  resolveMilestone(escrowId, milestoneId, decision, by = 'owner') {
    return this.serial(async () => {
      const esc = this.escrow(escrowId);
      const m = esc.milestones.find((x) => x.id === milestoneId);
      if (!m || m.status !== 'review') throw new HttpError(409, 'milestone is not awaiting review');
      this.log('escrow.human_resolved', escrowId, { milestone: m.id, decision, by });
      if (decision === 'release') await this.capture(esc, m, by);
      else m.status = 'pending';
      return esc;
    });
  }

  async capture(esc, m, by) {
    const isFinal = esc.milestones.every((x) => x === m || x.status === 'released');
    try {
      const out = await this.paypal.captureAuthorization(esc.paypal.authorizationId, { amountCents: m.amountCents, currency: esc.currency, finalCapture: isFinal, note: `${esc.title} – ${m.name}`, requestId: `${esc.id}-${m.id}` });
      m.status = 'released';
      m.captureId = out.captureId;
      m.releasedBy = by;
      esc.capturedCents += m.amountCents;
      if (isFinal) { esc.status = 'completed'; esc.committedCents = esc.capturedCents; }
      this.log('escrow.milestone_released', esc.id, { milestone: m.id, amount: fmt(m.amountCents, esc.currency), captureId: out.captureId, finalCapture: isFinal, by });
    } catch (e) {
      m.status = 'review';
      m.error = e.message;
      this.log('escrow.capture_failed', esc.id, { milestone: m.id, error: e.message });
    }
  }

  voidEscrow(id, by = 'owner') {
    return this.serial(async () => {
      const esc = this.escrow(id);
      if (['completed', 'cancelled', 'denied', 'rejected'].includes(esc.status)) throw new HttpError(409, `escrow is ${esc.status}`);
      if (esc.status === 'funded') {
        try { await this.paypal.voidAuthorization(esc.paypal.authorizationId); } catch (e) { throw new HttpError(502, e.message); }
        esc.committedCents = esc.capturedCents;
      }
      esc.status = 'cancelled';
      this.log('escrow.cancelled', id, { by, releasedToPayee: fmt(esc.capturedCents, esc.currency), returnedToBuyer: fmt(Math.max(0, esc.totalCents - esc.capturedCents), esc.currency) });
      return esc;
    });
  }

  refundMilestone(escrowId, milestoneId, by = 'owner') {
    return this.serial(async () => {
      const esc = this.escrow(escrowId);
      const m = esc.milestones.find((x) => x.id === milestoneId);
      if (!m || m.status !== 'released') throw new HttpError(409, 'milestone has not been released');
      const out = await this.paypal.refundCapture(m.captureId, { amountCents: m.amountCents, currency: esc.currency });
      m.status = 'refunded';
      esc.capturedCents -= m.amountCents;
      esc.committedCents = Math.max(0, esc.committedCents - m.amountCents);
      this.log('escrow.milestone_refunded', escrowId, { milestone: m.id, refundId: out.refundId, by });
      return esc;
    });
  }

  // ---------------------------------------------------------------- views
  reset() {
    return this.serial(async () => { this.store.reset(); });
  }

  snapshot() {
    const s = this.state;
    const metrics = computeMetrics(s, this.now());
    const byNew = (a, b) => (a.createdAt < b.createdAt ? 1 : -1);
    return {
      info: { paypal: this.paypal.mode, ai: this.ai.name, llm: this.ai.llmEnabled, now: new Date(this.now()).toISOString() },
      mandates: Object.values(s.mandates).map((m) => this.mandateView(m)),
      requests: Object.values(s.requests).sort(byNew),
      escrows: Object.values(s.escrows).sort(byNew),
      orders: Object.values(s.orders).sort(byNew).slice(0, 50),
      refunds: Object.values(s.refunds).sort(byNew).slice(0, 50),
      ledger: s.ledger.slice(-80).reverse(),
      ledgerStatus: this.store.ledgerStatus(),
      metrics, insights: insights(metrics),
      frozen: s.tenant.frozen,
      billing: { ...usageOf(s.tenant, this.now()), tenant: { plan: s.tenant.plan, subscription: s.tenant.subscription }, plans: Object.values(PLANS) },
    };
  }

  // ---------------------------------------------------------------- kill switch & what-if
  /** Global kill switch: while frozen, every agent request is hard-denied. */
  freeze(on, by = 'owner') {
    return this.serial(async () => {
      this.state.tenant.frozen = on ? { at: new Date(this.now()).toISOString(), by } : null;
      this.log(on ? 'security.frozen' : 'security.unfrozen', 'tenant', { by });
      return this.state.tenant;
    });
  }

  /** Dry-run: run the exact same rules + heuristic AI on a hypothetical request. Nothing is stored, logged or paid. */
  async simulate(mandateId, input) {
    const mandate = this.mandate(mandateId);
    const base = this.parseRequest(input);
    const req = { id: 'sim_preview', mandateId, ...base, createdAt: new Date(this.now()).toISOString() };
    const policy = evaluate({ mandate, request: req, state: this.state, secret: this.config.mandateSecret, now: this.now() });
    const ai = await this.ai.reviewRequest({ mandate, request: req, state: this.state }, { skipLLM: true });
    const final = strictest(policy.verdict, ai.recommendation);
    return { final, decidedBy: final === 'allow' ? 'both' : policy.verdict === final ? 'policy' : 'ai', policy, ai: { ...ai, reviewers: ['heuristic'] } };
  }

  // ---------------------------------------------------------------- copilot, billing, webhooks
  async ask(question) {
    const q = String(question || '').slice(0, 300);
    if (!q.trim()) throw new HttpError(400, 'ask a question');
    return this.ai.answer(q, computeMetrics(this.state, this.now()), answerOffline);
  }

  subscribe(plan) {
    return this.serial(async () => {
      if (!PLANS[plan] || plan === 'free') throw new HttpError(400, 'choose pro or scale');
      const planId = this.config.plans?.[plan];
      if (this.paypal.mode === 'sandbox-live' && !planId) throw new HttpError(400, `set PAYPAL_PLAN_${plan.toUpperCase()} (a sandbox billing plan id) to subscribe live`);
      const sub = await this.paypal.createSubscription({ planId: planId || `SIM-PLAN-${plan.toUpperCase()}`, customId: `tenant:${plan}` });
      this.state.tenant.subscription = { id: sub.id, plan, status: sub.status, approveUrl: sub.approveUrl };
      this.log('billing.subscription_created', sub.id, { plan, mode: this.paypal.mode });
      if (this.paypal.simulateSubscriptionApproval) await this._activateSubscription(sub.id);
      return this.state.tenant;
    });
  }

  async _activateSubscription(id) {
    const sub = this.state.tenant.subscription;
    if (!sub || sub.id !== id) return;
    if (this.paypal.simulateSubscriptionApproval) await this.paypal.simulateSubscriptionApproval(id);
    const live = await this.paypal.getSubscription(id);
    if (live.status !== 'ACTIVE') throw new HttpError(409, `subscription is ${live.status}`);
    sub.status = 'ACTIVE';
    this.state.tenant.plan = sub.plan;
    this.log('billing.plan_changed', id, { plan: sub.plan });
  }

  /** Signed PayPal webhook events (idempotent by event id). Signature is verified by the caller. */
  handleWebhook(event) {
    return this.serial(async () => {
      if (!event?.id || !event.event_type) throw new HttpError(400, 'malformed event');
      if (this.state.events[event.id]) return { duplicate: true };
      this.state.events[event.id] = event.event_type;
      const keys = Object.keys(this.state.events);
      if (keys.length > 2000) delete this.state.events[keys[0]];
      const res = event.resource || {};
      this.log('webhook.received', event.id, { type: event.event_type });
      switch (event.event_type) {
        case 'CHECKOUT.ORDER.APPROVED': {
          const order = Object.values(this.state.orders).find((o) => o.paypal?.orderId === res.id);
          if (order?.status === 'awaiting_buyer') await this.commerce._pay(order.id);
          break;
        }
        case 'PAYMENT.PAYOUTSBATCH.SUCCESS':
        case 'PAYMENT.PAYOUTSBATCH.DENIED': {
          const r = Object.values(this.state.requests).find((x) => x.paypal?.batchId === res.batch_header?.payout_batch_id);
          if (r) { r.paypal.status = event.event_type.endsWith('SUCCESS') ? 'SUCCESS' : 'DENIED'; if (r.paypal.status === 'DENIED') r.status = 'failed'; }
          break;
        }
        case 'BILLING.SUBSCRIPTION.ACTIVATED': await this._activateSubscription(res.id); break;
        case 'BILLING.SUBSCRIPTION.CANCELLED': if (this.state.tenant.subscription?.id === res.id) { this.state.tenant.plan = 'free'; this.log('billing.plan_changed', res.id, { plan: 'free' }); } break;
        default: break;
      }
      return { ok: true };
    });
  }
}
