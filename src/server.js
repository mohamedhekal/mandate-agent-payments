import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootstrapEnv, ROOT } from './config.js';
import { Store } from './store.js';
import { createPayPal } from './paypal/index.js';
import { createAI } from './ai/index.js';
import { Engine } from './engine.js';
import { HttpError } from './errors.js';
import { CATALOG } from './commerce.js';
import { SCENARIOS, runScenario, ensureDemoMandate } from './scenarios.js';
import { buildReport, exportData, toCSV, proofFor, actorOf } from './reports.js';
import { Auth, RateLimiter, SECURITY_HEADERS, safeEqual } from './security.js';

const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function buildEngine(config, overrides = {}) {
  return new Engine({
    store: overrides.store || new Store(config.dataFile),
    paypal: overrides.paypal || createPayPal(config),
    ai: overrides.ai || createAI(config),
    config,
    now: overrides.now,
  });
}

// ---- response helpers (security headers on everything, gzip + ETag where it pays off) ----
const staticCache = new Map();
function send(req, res, status, body, headers = {}) {
  const isJson = body !== null && typeof body === 'object';
  let payload = isJson ? JSON.stringify(body) : String(body ?? '');
  const h = { 'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers };
  if (isJson && req.method === 'GET' && status === 200 && payload.length > 512) {
    const etag = `"${crypto.createHash('sha1').update(payload).digest('base64url')}"`;
    h.ETag = etag;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
  }
  if (payload.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    payload = zlib.gzipSync(payload, { level: 4 });
    h['Content-Encoding'] = 'gzip';
    h.Vary = 'Accept-Encoding';
  }
  res.writeHead(status, h);
  res.end(payload);
}

function sendStatic(req, res, file) {
  const stat = fs.statSync(file);
  let entry = staticCache.get(file);
  if (!entry || entry.mtime !== stat.mtimeMs) {
    const raw = fs.readFileSync(file);
    entry = { mtime: stat.mtimeMs, raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: `"${crypto.createHash('sha1').update(raw).digest('base64url')}"` };
    staticCache.set(file, entry);
  }
  const h = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: entry.etag, ...SECURITY_HEADERS, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, h); return res.end(); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gz) h['Content-Encoding'] = 'gzip';
  res.writeHead(200, h);
  res.end(gz ? entry.gz : entry.raw);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
}

/** Raw body needed for webhook verification. */
async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 200_000) throw new HttpError(413, 'body too large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

const publicRequest = (r) => {
  const { decision, ...rest } = r;
  return {
    ...rest,
    decision: decision && {
      final: decision.final, decidedBy: decision.decidedBy,
      failedChecks: decision.policy.checks.filter((c) => !c.pass).map((c) => ({ id: c.id, label: c.label, detail: c.detail })),
      ai: { risk: decision.ai.risk, recommendation: decision.ai.recommendation, rationale: decision.ai.rationale },
    },
  };
};

/** What a storefront customer may see of an order (never the AI/policy internals or other people's data). */
const customerOrder = (o) => ({ id: o.id, status: o.status, items: o.items, totalCents: o.totalCents, refundedCents: o.refundedCents, approveUrl: o.paypal?.approveUrl, createdAt: o.createdAt, paidAt: o.paidAt });
const customerRefund = (r) => ({ id: r.id, status: r.status, amountCents: r.amountCents, reason: r.reason, createdAt: r.createdAt });

export function createServer(engine, config) {
  const auth = new Auth({ adminToken: config.adminToken, secureCookie: config.publicUrl.startsWith('https://'), now: () => Date.now() });
  const limiter = new RateLimiter();
  const sec = (type, ip, detail) => engine.store.secLog(type, ip, detail, Date.now());
  const limit = (key, max, windowMs = 60_000) => {
    const r = limiter.take(key, max, windowMs);
    if (!r.ok) { if (!key.startsWith('ip:')) sec('rate_limited', key.split(':').slice(1).join(':').slice(0, 40), { bucket: key.split(':')[0] }); throw Object.assign(new HttpError(429, 'too many requests'), { retryAfter: r.retryAfter }); }
  };

  const route = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = req.method;
    const seg = p.split('/').filter(Boolean);
    // Behind a reverse proxy (Render etc.) every client shares the proxy's socket address; trust X-Forwarded-For only when told to.
    const ip = (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
    const out = (status, body, h) => send(req, res, status, body, h);
    limit(`ip:${ip}`, 900);

    // ---------------- PayPal webhooks: verified before they touch state ----------------
    if (m === 'POST' && p === '/webhooks/paypal') {
      limit(`wh:${ip}`, 120);
      const raw = await readRaw(req);
      let event;
      try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid JSON'); }
      let valid;
      if (engine.paypal.verifyWebhook && config.webhookId) valid = await engine.paypal.verifyWebhook({ headers: req.headers, event, webhookId: config.webhookId });
      else if (engine.paypal.mode === 'simulated') valid = safeEqual(req.headers['x-mandate-signature'] || '', crypto.createHmac('sha256', config.mandateSecret).update(raw).digest('hex'));
      else throw new HttpError(503, 'webhooks disabled: set PAYPAL_WEBHOOK_ID');
      if (!valid) { sec('webhook_rejected', ip, { reason: 'bad signature' }); throw new HttpError(401, 'invalid webhook signature'); }
      return out(200, await engine.handleWebhook(event));
    }

    // ---------------- agent API (bearer token == one mandate) ----------------
    if (seg[0] === 'api' && seg[1] === 'agent') {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      limit(`agent:${token.slice(0, 12) || ip}`, 60);
      const mandate = engine.mandateByToken(token);
      if (!mandate) { sec('agent_token_rejected', ip, {}); limit(`badtoken:${ip}`, 20); return out(401, { error: 'invalid agent token' }); }
      if (m === 'GET' && seg[2] === 'mandate') return out(200, engine.mandateView(mandate));
      if (m === 'GET' && seg[2] === 'catalog') return out(200, CATALOG);
      if (m === 'POST' && seg[2] === 'payments') return out(200, publicRequest(await engine.submitPayment(mandate.id, await readJson(req))));
      if (m === 'POST' && seg[2] === 'purchase') {
        const b = await readJson(req);
        let o = await engine.commerce.createOrder({ sku: b.sku, qty: b.qty, mandateId: mandate.id });
        if (o.status === 'awaiting_buyer' && engine.paypal.simulateBuyerApproval) o = await engine.commerce.payOrder(o.id);
        return out(200, publicRequest(o));
      }
      if (m === 'POST' && seg[2] === 'escrows' && !seg[3]) return out(200, await engine.createEscrow(mandate.id, await readJson(req)));
      if (m === 'POST' && seg[2] === 'escrows' && seg[4] === 'deliver') {
        const esc = engine.escrow(seg[3]);
        if (esc.mandateId !== mandate.id) throw new HttpError(403, 'escrow belongs to another mandate');
        const body = await readJson(req);
        return out(200, await engine.submitDeliverable(seg[3], body.milestoneId, body.deliverable));
      }
      if (m === 'GET' && seg[2] === 'requests' && seg[3]) {
        const r = engine.state.requests[seg[3]] || engine.state.escrows[seg[3]] || engine.state.orders[seg[3]];
        if (!r || r.mandateId !== mandate.id) throw new HttpError(404, 'not found');
        return out(200, publicRequest(r));
      }
      throw new HttpError(404, 'unknown agent endpoint');
    }

    // ---------------- public storefront API (customers; no admin session) ----------------
    if (seg[0] === 'api' && seg[1] === 'shop') {
      limit(`shop:${ip}`, 40);
      if (m === 'GET' && seg[2] === 'catalog') return out(200, { merchant: 'Demo Data & Design Store', catalog: CATALOG, paypal: engine.paypal.mode });
      if (m === 'POST' && seg[2] === 'orders' && !seg[3]) {
        const b = await readJson(req);
        const o = await engine.commerce.createOrder({ sku: b.sku, qty: b.qty, customerEmail: b.customerEmail });
        return out(200, customerOrder(o));
      }
      if (seg[2] === 'orders' && seg[3]) {
        const o = engine.state.orders[seg[3]];
        const body = m === 'POST' ? await readJson(req) : {};
        const email = String(url.searchParams.get('email') || body.email || '').toLowerCase();
        // Order ids alone are not enough: the buyer's email must match (prevents enumeration / IDOR).
        if (!o || o.mandateId || !email || !safeEqual(email, o.customerEmail)) throw new HttpError(404, 'order not found');
        if (m === 'GET' && !seg[4]) return out(200, { ...customerOrder(o), refunds: Object.values(engine.state.refunds).filter((r) => r.orderId === o.id).map(customerRefund) });
        if (m === 'POST' && seg[4] === 'pay') return out(200, customerOrder(await engine.commerce.payOrder(o.id)));
        if (m === 'POST' && seg[4] === 'refund') {
          return out(200, customerRefund(await engine.commerce.requestRefund(o.id, { reason: body.reason, amount: body.amount, requester: 'customer' })));
        }
      }
      throw new HttpError(404, 'unknown shop endpoint');
    }

    // ---------------- session endpoints ----------------
    if (seg[0] === 'api' && seg[1] === 'session') {
      if (m === 'POST' && !seg[2]) {
        limit(`login:${ip}`, 6);
        const { token } = await readJson(req);
        const s = auth.login(String(token || ''));
        if (!s) { sec('login_failed', ip, {}); return out(401, { error: 'invalid token' }); }
        sec('login_ok', ip, {});
        return out(200, { ok: true, csrf: s.csrf }, { 'Set-Cookie': s.cookie });
      }
      const sess = auth.session(req);
      if (m === 'GET') return out(200, { authenticated: !!sess || config.authDisabled, csrf: sess?.csrf || 'disabled' });
      if (m === 'POST' && seg[2] === 'logout') { if (sess) { auth.logout(sess.sid); sec('logout', ip, {}); } return out(200, { ok: true }, { 'Set-Cookie': 'mandate_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
    }

    // ---------------- PayPal return URLs (browser redirects, GET) ----------------
    if (m === 'GET' && p === '/paypal/return') {
      const token = url.searchParams.get('token');
      const subId = url.searchParams.get('subscription_id');
      if (subId) await engine.serial(() => engine._activateSubscription(subId)).catch(() => {});
      const esc = Object.values(engine.state.escrows).find((e) => e.paypal?.orderId === token);
      if (esc && esc.status === 'awaiting_funding') await engine.fundEscrow(esc.id).catch(() => {});
      const ord = Object.values(engine.state.orders).find((o) => o.paypal?.orderId === token);
      if (ord && ord.status === 'awaiting_buyer') await engine.commerce.payOrder(ord.id).catch(() => {});
      return out(302, '', { Location: ord && !ord.mandateId ? `/shop.html?order=${ord.id}` : '/' });
    }
    if (m === 'GET' && p === '/paypal/cancel') return out(302, '', { Location: '/' });

    // ---------------- human / dashboard API (admin session + CSRF) ----------------
    if (seg[0] === 'api') {
      if (!config.authDisabled) {
        const chk = auth.check(req, { mutating: m !== 'GET' });
        if (!chk.ok) { sec(chk.status === 401 ? 'unauthenticated_request' : 'csrf_or_origin_blocked', ip, { path: p, method: m }); return out(chk.status, { error: chk.error }); }
      }
      if (m === 'GET' && seg[1] === 'state') return out(200, { ...engine.snapshot(), scenarios: SCENARIOS, demoMode: config.demoMode });
      if (m === 'GET' && seg[1] === 'ledger' && seg[2] === 'verify') return out(200, engine.store.verifyLedger());
      if (m === 'GET' && seg[1] === 'reports' && !seg[2]) return out(200, buildReport(engine.state, { days: Math.min(365, Math.max(0, Number(url.searchParams.get('days') ?? 30) || 0)), now: engine.now() }));
      if (m === 'GET' && seg[1] === 'reports' && seg[2] === 'export') {
        const type = url.searchParams.get('type') || 'transactions';
        const ex = exportData(engine.state, type, engine.now());
        const stamp = new Date(engine.now()).toISOString().slice(0, 10);
        if (url.searchParams.get('format') === 'json') return out(200, ex.rows, { 'Content-Disposition': `attachment; filename="${ex.name}-${stamp}.json"` });
        return out(200, toCSV(ex.rows, ex.cols), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${ex.name}-${stamp}.csv"` });
      }
      if (m === 'GET' && seg[1] === 'transactions') return out(200, exportData(engine.state, 'transactions', engine.now()).rows.slice(0, 2000));
      if (m === 'GET' && seg[1] === 'audit' && !seg[2]) {
        const q = String(url.searchParams.get('q') || '').toLowerCase().slice(0, 80);
        const type = url.searchParams.get('type') || '';
        const actor = url.searchParams.get('actor') || '';
        const limitN = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const chain = engine.store.ledgerStatus();
        const all = engine.state.ledger;
        const rows = all.filter((e) => (!type || e.type.startsWith(type)) && (!actor || actorOf(e) === actor) && (!q || `${e.type} ${e.ref} ${JSON.stringify(e.data)}`.toLowerCase().includes(q)));
        const page = rows.slice().reverse().slice(offset, offset + limitN).map((e) => ({ ...e, actor: actorOf(e), ok: chain.ok || e.seq < chain.brokenAt }));
        return out(200, { total: rows.length, offset, entries: page, chain, types: [...new Set(all.map((e) => e.type.split('.')[0]))], actors: [...new Set(all.map(actorOf))], tampered: !!engine.store._tamper });
      }
      if (m === 'GET' && seg[1] === 'audit' && seg[2] === 'proof' && seg[3]) { const pr = proofFor(engine.state, seg[3]); if (!pr) throw new HttpError(404, 'nothing on record for that id'); return out(200, pr); }
      if (m === 'GET' && seg[1] === 'security-log') return out(200, { events: (engine.state.secEvents || []).slice().reverse().slice(0, 200), frozen: engine.state.tenant.frozen });
      if (m === 'POST' && seg[1] === 'freeze') { const { on } = await readJson(req); sec(on ? 'kill_switch_on' : 'kill_switch_off', ip, {}); return out(200, await engine.freeze(!!on)); }
      if (m === 'POST' && seg[1] === 'simulate') { const b = await readJson(req); return out(200, await engine.simulate(b.mandateId, b)); }
      if (m === 'POST' && seg[1] === 'demo' && (seg[2] === 'tamper' || seg[2] === 'restore')) {
        if (!config.demoMode) throw new HttpError(403, 'disabled (DEMO_MODE=0)');
        if (seg[2] === 'tamper') { const n = engine.store.tamper(); if (!n) throw new HttpError(409, 'already tampered or ledger empty'); sec('demo_tamper', ip, { seq: n }); return out(200, { tamperedSeq: n }); }
        return out(200, { restored: engine.store.restore() });
      }
      if (m === 'POST' && seg[1] === 'reset') { if (!config.demoMode) throw new HttpError(403, 'reset disabled (DEMO_MODE=0)'); await engine.reset(); return out(200, { ok: true }); }
      if (m === 'POST' && seg[1] === 'demo' && seg[2] === 'setup') return out(200, await ensureDemoMandate(engine, config));
      if (m === 'POST' && seg[1] === 'scenarios' && seg[2]) { if (!config.demoMode) throw new HttpError(403, 'scenarios disabled (DEMO_MODE=0)'); return out(200, await runScenario(engine, seg[2], config)); }
      if (m === 'POST' && seg[1] === 'copilot') { const { question } = await readJson(req); return out(200, await engine.ask(question)); }
      if (m === 'POST' && seg[1] === 'billing' && seg[2] === 'subscribe') { const { plan } = await readJson(req); return out(200, await engine.subscribe(plan)); }
      if (m === 'POST' && seg[1] === 'mandates' && seg[2] === 'draft') {
        const { text } = await readJson(req);
        if (!text || String(text).length > 1000) throw new HttpError(400, 'describe the mandate in 1-1000 characters');
        try { return out(200, await engine.ai.draftMandate(text)); } catch (e) { throw new HttpError(422, e.message); }
      }
      if (m === 'POST' && seg[1] === 'mandates' && !seg[2]) return out(200, await engine.createMandate(await readJson(req)));
      if (m === 'POST' && seg[1] === 'mandates' && seg[3] === 'revoke') return out(200, await engine.revokeMandate(seg[2]));
      if (m === 'POST' && seg[1] === 'mandates' && seg[3] === 'rotate') return out(200, await engine.rotateToken(seg[2]));
      if (m === 'POST' && seg[1] === 'payments') { const b = await readJson(req); return out(200, await engine.submitPayment(b.mandateId, b)); }
      if (m === 'POST' && seg[1] === 'escrows' && !seg[2]) { const b = await readJson(req); return out(200, await engine.createEscrow(b.mandateId, b)); }
      if (m === 'POST' && seg[1] === 'escrows' && seg[3] === 'fund') return out(200, await engine.fundEscrow(seg[2]));
      if (m === 'POST' && seg[1] === 'escrows' && seg[3] === 'void') return out(200, await engine.voidEscrow(seg[2]));
      if (m === 'POST' && seg[1] === 'escrows' && seg[3] === 'deliver') { const b = await readJson(req); return out(200, await engine.submitDeliverable(seg[2], b.milestoneId, b.deliverable)); }
      if (m === 'POST' && seg[1] === 'escrows' && seg[3] === 'resolve') { const b = await readJson(req); return out(200, await engine.resolveMilestone(seg[2], b.milestoneId, b.decision)); }
      if (m === 'POST' && seg[1] === 'escrows' && seg[3] === 'refund') { const b = await readJson(req); return out(200, await engine.refundMilestone(seg[2], b.milestoneId)); }
      if (m === 'POST' && seg[1] === 'orders' && seg[3] === 'pay') return out(200, await engine.commerce.payOrder(seg[2]));
      if (m === 'POST' && seg[1] === 'orders' && seg[3] === 'refund') { const b = await readJson(req); return out(200, await engine.commerce.requestRefund(seg[2], { reason: b.reason, amount: b.amount, requester: 'owner' })); }
      if (m === 'POST' && seg[1] === 'approvals' && seg[3] === 'approve') return out(200, await engine.approve(seg[2]));
      if (m === 'POST' && seg[1] === 'approvals' && seg[3] === 'reject') return out(200, await engine.reject(seg[2]));
      throw new HttpError(404, 'unknown endpoint');
    }

    // ---------------- static ----------------
    if (m === 'GET') {
      const rel = p === '/' ? 'index.html' : decodeURIComponent(p);
      const file = path.normalize(path.join(PUBLIC, rel));
      if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendStatic(req, res, file);
    }
    throw new HttpError(404, 'not found');
  };

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err.status && err.status < 600 ? err.status : 500;
      if (status >= 500) console.error(err);
      const extra = status === 413 ? { Connection: 'close' } : err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
      if (!res.headersSent) send(req, res, status, { error: status >= 500 && err.name !== 'PayPalError' ? 'internal error' : err.message }, extra);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.auth = auth;
  return server;
}

/** Secrets that must exist but should never be hard-coded: generate once, keep in a 0600 file next to the data. */
function ensureSecret(env, key, file, bytes = 32) {
  if (env[key]) return env[key];
  const f = path.join(ROOT, 'data', file);
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* create below */ }
  const v = crypto.randomBytes(bytes).toString('base64url');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, v, { mode: 0o600 });
  return v;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const config = bootstrapEnv();
  config.mandateSecret = ensureSecret(process.env, 'MANDATE_SECRET', '.mandate-secret');
  const generated = !config.adminToken;
  if (generated) config.adminToken = ensureSecret(process.env, 'ADMIN_TOKEN', '.admin-token', 18);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && generated) console.warn('  ! Binding to a public interface with a generated admin token — set ADMIN_TOKEN explicitly.');
  const engine = buildEngine(config);
  createServer(engine, config).listen(config.port, config.host, () => {
    console.log(`\n  Mandate is running →  ${config.publicUrl}   (storefront: ${config.publicUrl}/shop.html)`);
    console.log(`  PayPal : ${engine.paypal.mode === 'sandbox-live' ? 'SANDBOX (live API calls to api-m.sandbox.paypal.com)' : 'SIMULATED sandbox (no credentials set)'}`);
    console.log(`  AI     : ${engine.ai.name}`);
    console.log(`  Admin  : sign in with token  ${config.adminToken}${generated ? '   (generated; stored in data/.admin-token)' : ''}\n`);
  });
}
