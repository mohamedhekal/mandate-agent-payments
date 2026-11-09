// `npm run demo` — runs the whole story headlessly against the in-memory engine (simulated PayPal sandbox,
// or the live sandbox if PAYPAL_CLIENT_ID/SECRET are set) and prints a readable transcript.
import { bootstrapEnv } from '../src/config.js';
import { buildEngine } from '../src/server.js';
import { Store } from '../src/store.js';
import { SCENARIOS, runScenario } from '../src/scenarios.js';

const config = { ...bootstrapEnv(), dataFile: null };
const engine = buildEngine(config, { store: new Store(null) });
console.log(`PayPal: ${engine.paypal.mode} | AI: ${engine.ai.name}\n`);

const icon = { executed: '✅ PAID   ', denied: '⛔ BLOCKED', pending_approval: '✋ HUMAN  ', funded: '🔒 HELD   ', awaiting_funding: '⏳ FUNDING' };
for (const s of SCENARIOS) {
  const r = await runScenario(engine, s.id, config);
  const d = r.decision;
  console.log(`${icon[r.status] || r.status}  ${s.title}`);
  console.log(`   ${s.blurb}`);
  if (d) console.log(`   decided by: ${d.decidedBy} | AI risk ${d.ai.risk} → ${d.ai.recommendation} | ${d.ai.rationale.slice(0, 150)}`);
  if (r.milestones) for (const m of r.milestones) console.log(`   milestone ${m.name}: ${m.status} — ${m.attempts.at(-1)?.verdict.rationale ?? ''}`);
  console.log();
}
const v = engine.store.verifyLedger();
console.log(`Audit ledger: ${v.length} hash-chained entries, integrity ${v.ok ? 'OK' : 'BROKEN'}`);
