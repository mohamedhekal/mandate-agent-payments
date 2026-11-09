import crypto from 'node:crypto';
import { fromCents } from '../money.js';

// SAFETY: this app can only ever talk to the PayPal SANDBOX. There is deliberately no switch for production.
export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

export class PayPalError extends Error {
  constructor(status, body, op) {
    const issue = body?.details?.[0]?.issue;
    super(`PayPal ${op} failed: ${status} ${body?.name || ''}${issue ? ` (${issue})` : ''} ${body?.message || ''}`.trim());
    this.status = status;
    this.name = 'PayPalError';
    this.paypal = body;
    this.debugId = body?.debug_id;
  }
}

/** Thin PayPal REST client (OAuth2 client-credentials, idempotent POSTs). Sandbox only. */
export class PayPalLive {
  mode = 'sandbox-live';

  constructor({ clientId, clientSecret, payeeEmail = '', publicUrl, fetchImpl = fetch, base = SANDBOX_BASE }) {
    if (new URL(base).host !== 'api-m.sandbox.paypal.com') throw new Error('Refusing to use a non-sandbox PayPal host');
    Object.assign(this, { clientId, clientSecret, payeeEmail, publicUrl, fetchImpl, base });
    this.token = null;
  }

  async accessToken() {
    if (this.token && this.token.exp > Date.now() + 30_000) return this.token.value;
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(res.status, { name: body.error, message: body.error_description }, 'oauth');
    this.token = { value: body.access_token, exp: Date.now() + (body.expires_in || 300) * 1000 };
    return this.token.value;
  }

  async call(method, path, { body, requestId, op } = {}) {
    const headers = { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
    if (method === 'POST') headers['PayPal-Request-Id'] = requestId || crypto.randomUUID();
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new PayPalError(res.status, json, op || `${method} ${path}`);
    return json;
  }

  // ---- Payouts: autonomous agent -> payee transfer, funded by the sandbox business account ----
  async createPayout({ batchId, items }) {
    const out = await this.call('POST', '/v1/payments/payouts', {
      op: 'create payout',
      requestId: batchId,
      body: {
        sender_batch_header: { sender_batch_id: batchId, email_subject: 'You have a payment from an AI agent (sandbox)', email_message: 'Paid under a signed spending mandate.' },
        items: items.map((i) => ({
          recipient_type: 'EMAIL',
          receiver: i.receiver,
          amount: { value: fromCents(i.amountCents), currency: i.currency },
          note: i.note?.slice(0, 160),
          sender_item_id: i.itemId,
        })),
      },
    });
    return { batchId: out.batch_header.payout_batch_id, status: out.batch_header.batch_status };
  }

  async getPayout(batchId) {
    const out = await this.call('GET', `/v1/payments/payouts/${batchId}`, { op: 'get payout' });
    return { batchId, status: out.batch_header.batch_status, items: (out.items || []).map((i) => ({ status: i.transaction_status, receiver: i.payout_item?.receiver })) };
  }

  // ---- Orders v2: escrow = AUTHORIZE now, CAPTURE per milestone, VOID the rest ----
  async createOrder({ amountCents, currency, description, customId, requestId, intent = 'AUTHORIZE' }) {
    const purchase = { custom_id: customId, description: description?.slice(0, 127), amount: { currency_code: currency, value: fromCents(amountCents) } };
    if (this.payeeEmail) purchase.payee = { email_address: this.payeeEmail };
    const out = await this.call('POST', '/v2/checkout/orders', {
      op: 'create order',
      requestId,
      body: {
        intent,
        purchase_units: [purchase],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Mandate (sandbox)',
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
              return_url: `${this.publicUrl}/paypal/return`,
              cancel_url: `${this.publicUrl}/paypal/cancel`,
            },
          },
        },
      },
    });
    const link = out.links?.find((l) => ['payer-action', 'approve'].includes(l.rel));
    return { id: out.id, status: out.status, approveUrl: link?.href };
  }

  async getOrder(id) {
    const out = await this.call('GET', `/v2/checkout/orders/${id}`, { op: 'get order' });
    return { id: out.id, status: out.status };
  }

  /** intent=CAPTURE orders (storefront checkout): capture immediately after buyer approval. */
  async captureOrder(id) {
    const out = await this.call('POST', `/v2/checkout/orders/${id}/capture`, { op: 'capture order', requestId: `cap-${id}` });
    const cap = out.purchase_units?.[0]?.payments?.captures?.[0];
    if (!cap) throw new PayPalError(422, { name: 'NO_CAPTURE', message: 'order not captured' }, 'capture order');
    return { captureId: cap.id, status: cap.status };
  }

  async authorizeOrder(id) {
    const out = await this.call('POST', `/v2/checkout/orders/${id}/authorize`, { op: 'authorize order', requestId: `auth-${id}` });
    const auth = out.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth) throw new PayPalError(422, { name: 'NO_AUTHORIZATION', message: 'order not authorized' }, 'authorize order');
    return { authorizationId: auth.id, status: auth.status };
  }

  async captureAuthorization(authId, { amountCents, currency, finalCapture, note, requestId }) {
    const out = await this.call('POST', `/v2/payments/authorizations/${authId}/capture`, {
      op: 'capture authorization',
      requestId,
      body: { amount: { currency_code: currency, value: fromCents(amountCents) }, final_capture: !!finalCapture, note_to_payer: note?.slice(0, 255) },
    });
    return { captureId: out.id, status: out.status };
  }

  async voidAuthorization(authId) {
    await this.call('POST', `/v2/payments/authorizations/${authId}/void`, { op: 'void authorization', requestId: `void-${authId}` });
    return { status: 'VOIDED' };
  }

  // ---- Subscriptions (billing the SaaS plan itself) ----
  async createSubscription({ planId, customId }) {
    const out = await this.call('POST', '/v1/billing/subscriptions', {
      op: 'create subscription',
      requestId: customId,
      body: { plan_id: planId, custom_id: customId, application_context: { brand_name: 'Mandate (sandbox)', user_action: 'SUBSCRIBE_NOW', return_url: `${this.publicUrl}/paypal/return`, cancel_url: `${this.publicUrl}/paypal/cancel` } },
    });
    return { id: out.id, status: out.status, approveUrl: out.links?.find((l) => l.rel === 'approve')?.href };
  }

  async getSubscription(id) {
    const out = await this.call('GET', `/v1/billing/subscriptions/${id}`, { op: 'get subscription' });
    return { id: out.id, status: out.status, planId: out.plan_id };
  }

  /** Server-side webhook signature verification via PayPal (never trust unsigned webhooks). */
  async verifyWebhook({ headers, event, webhookId }) {
    const out = await this.call('POST', '/v1/notifications/verify-webhook-signature', {
      op: 'verify webhook',
      body: {
        auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: webhookId, webhook_event: event,
      },
    });
    return out.verification_status === 'SUCCESS';
  }

  async refundCapture(captureId, { amountCents, currency }) {
    const out = await this.call('POST', `/v2/payments/captures/${captureId}/refund`, {
      op: 'refund capture',
      body: amountCents ? { amount: { currency_code: currency, value: fromCents(amountCents) } } : {},
    });
    return { refundId: out.id, status: out.status };
  }
}
