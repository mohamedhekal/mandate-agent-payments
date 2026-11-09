import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
/** Constant-time string comparison (hash both sides so lengths never leak). */
export const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Fixed-window rate limiter. Returns {ok, retryAfter}. Memory-bounded. */
export class RateLimiter {
  constructor(now = () => Date.now()) { this.hits = new Map(); this.now = now; }
  take(key, max, windowMs) {
    const t = this.now();
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    let h = this.hits.get(key);
    if (!h || h.reset <= t) { h = { n: 0, reset: t + windowMs }; this.hits.set(key, h); }
    h.n += 1;
    return h.n <= max ? { ok: true } : { ok: false, retryAfter: Math.ceil((h.reset - t) / 1000) };
  }
}

/**
 * Operator authentication for the dashboard / human API.
 *  - one admin token (env ADMIN_TOKEN, or generated at boot) exchanged for an HttpOnly, SameSite=Strict session cookie
 *  - per-session CSRF token required (header) on every mutating request
 *  - sessions expire (8h) and are capped
 */
export class Auth {
  constructor({ adminToken, secureCookie = false, now = () => Date.now(), ttlMs = 8 * 3600_000 }) {
    this.adminToken = adminToken;
    this.secure = secureCookie;
    this.now = now;
    this.ttl = ttlMs;
    this.sessions = new Map();
  }

  login(token) {
    if (!token || !safeEqual(token, this.adminToken)) return null;
    if (this.sessions.size > 200) this.sessions.delete(this.sessions.keys().next().value);
    const sid = crypto.randomBytes(32).toString('base64url');
    const s = { csrf: crypto.randomBytes(24).toString('base64url'), exp: this.now() + this.ttl };
    this.sessions.set(sid, s);
    return { sid, csrf: s.csrf, cookie: `mandate_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.ttl / 1000)}${this.secure ? '; Secure' : ''}` };
  }

  logout(sid) { this.sessions.delete(sid); }

  session(req) {
    const m = /(?:^|;\s*)mandate_sid=([\w-]+)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const s = this.sessions.get(m[1]);
    if (!s || s.exp < this.now()) { this.sessions.delete(m[1]); return null; }
    return { sid: m[1], ...s };
  }

  /** Throws-style check: returns {ok, status, error}. */
  check(req, { mutating }) {
    const s = this.session(req);
    if (!s) return { ok: false, status: 401, error: 'authentication required' };
    if (mutating) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return { ok: false, status: 403, error: 'cross-origin request blocked' };
      if (!req.headers['x-csrf-token'] || !safeEqual(req.headers['x-csrf-token'], s.csrf)) return { ok: false, status: 403, error: 'invalid CSRF token' };
    }
    return { ok: true, session: s };
  }
}
