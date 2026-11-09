import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

const empty = () => ({ mandates: {}, requests: {}, escrows: {}, orders: {}, refunds: {}, events: {}, tenant: { plan: 'free', subscription: null, meter: {}, frozen: null }, secEvents: [], ledger: [] });

/** In-memory state with optional JSON persistence. Single-process, synchronous writes. */
export class Store {
  constructor(file = null) {
    this.file = file;
    this.state = empty();
    if (file && fs.existsSync(file)) {
      try {
        this.state = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        this.state = empty();
      }
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 }); // atomic: write temp, then rename
    fs.renameSync(tmp, this.file);
  }

  reset() {
    this.state = empty();
    this._cache = null;
    this.save();
  }

  /** Append-only, hash-chained audit log. Each entry commits to the previous one. */
  log(type, ref, data, now = Date.now()) {
    const prev = this.state.ledger.at(-1)?.hash ?? 'GENESIS';
    const entry = { seq: this.state.ledger.length + 1, at: new Date(now).toISOString(), type, ref, data, prev };
    entry.hash = sha256(prev + canonical({ seq: entry.seq, at: entry.at, type, ref, data }));
    this.state.ledger.push(entry);
    this._cache = null;
    return entry;
  }

  /** Security/operations events (logins, blocked requests, rate limits). Separate from the money ledger; capped ring buffer. */
  secLog(type, ip, detail = {}, now = Date.now()) {
    const ev = this.state.secEvents || (this.state.secEvents = []);
    ev.push({ at: new Date(now).toISOString(), type, ip, detail });
    if (ev.length > 500) ev.splice(0, ev.length - 500);
  }

  /** Demo: corrupt one old entry (in memory) so the chain visibly breaks; restore() undoes it. */
  tamper(seq) {
    const e = this.state.ledger.find((x) => x.seq === seq) || this.state.ledger[Math.floor(this.state.ledger.length / 2)];
    if (!e || this._tamper) return null;
    this._tamper = { seq: e.seq, data: JSON.parse(JSON.stringify(e.data)) };
    e.data = { ...e.data, tampered: true, amount: '$0.01' };
    this._cache = null;
    return e.seq;
  }

  restore() {
    if (!this._tamper) return false;
    const e = this.state.ledger.find((x) => x.seq === this._tamper.seq);
    if (e) e.data = this._tamper.data;
    this._tamper = null;
    this._cache = null;
    return true;
  }

  /** Cheap status for every dashboard refresh: full verify only when the ledger changed. */
  ledgerStatus() {
    const n = this.state.ledger.length;
    if (!this._cache || this._cache.length !== n) this._cache = this.verifyLedger();
    return this._cache;
  }

  verifyLedger() {
    let prev = 'GENESIS';
    for (const e of this.state.ledger) {
      const expect = sha256(prev + canonical({ seq: e.seq, at: e.at, type: e.type, ref: e.ref, data: e.data }));
      if (e.prev !== prev || e.hash !== expect) return { ok: false, brokenAt: e.seq, length: this.state.ledger.length };
      prev = e.hash;
    }
    return { ok: true, length: this.state.ledger.length, head: prev };
  }
}
