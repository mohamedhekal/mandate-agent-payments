import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, fromCents, fmt } from '../src/money.js';
import { createMandate, verifyMandate, tokenMatches } from '../src/mandate.js';
import { Store } from '../src/store.js';
import { makeEngine, mandateInput, payInput } from './helpers.js';

test('money: exact integer cents, strict parsing', () => {
  assert.equal(toCents('12.34'), 1234);
  assert.equal(toCents(5), 500);
  assert.equal(toCents('$0.5'), 50);
  assert.equal(fromCents(1999), '19.99');
  assert.equal(fmt(250), '$2.50');
  for (const bad of ['1.234', '-5', 'abc', '', null, '1e3']) assert.throws(() => toCents(bad), undefined, String(bad));
});

test('mandate: signed, tamper-evident, token stored only as hash', () => {
  const { mandate, agentToken } = createMandate(mandateInput(), { secret: 's' });
  assert.ok(verifyMandate(mandate, 's'));
  assert.ok(!verifyMandate(mandate, 'other-secret'));
  assert.ok(!verifyMandate({ ...mandate, budgetCents: mandate.budgetCents * 100 }, 's'), 'raising the budget must break the signature');
  assert.ok(!verifyMandate({ ...mandate, payees: [...mandate.payees, 'evil@x.example'] }, 's'));
  assert.ok(tokenMatches(mandate, agentToken));
  assert.ok(!tokenMatches(mandate, 'mat_wrong'));
  assert.ok(!JSON.stringify(mandate).includes(agentToken));
});

test('mandate: validation', () => {
  const mk = (o) => () => createMandate(mandateInput(o), { secret: 's' });
  assert.throws(mk({ perTx: '500' }), /per-transaction/);
  assert.throws(mk({ approvalOver: '150' }), /approval threshold/);
  assert.throws(mk({ categories: ['crypto'] }), /unknown category/);
  assert.throws(mk({ categories: [] }), /category/);
  assert.throws(mk({ payees: ['not an email'] }), /invalid payee/);
  assert.throws(mk({ budget: '0' }), /budget/);
  assert.throws(mk({ agent: '' }), /agent/);
});

test('ledger: hash chain detects tampering anywhere in history', () => {
  const s = new Store(null);
  for (let i = 0; i < 5; i++) s.log('evt', `r${i}`, { i });
  assert.deepEqual(s.verifyLedger().ok, true);
  s.state.ledger[2].data.i = 999;
  const v = s.verifyLedger();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 3);
});

test('engine: in-policy payment is auto-approved and paid out', async () => {
  const e = makeEngine();
  const { mandate } = await e.createMandate(mandateInput());
  const r = await e.submitPayment(mandate.id, payInput());
  assert.equal(r.status, 'executed');
  assert.equal(r.decision.final, 'allow');
  assert.equal(r.paypal.rail, 'payouts');
  assert.equal(e.mandateView(e.mandate(mandate.id)).spentCents, 2000);
  assert.ok(e.store.verifyLedger().ok);
});

test('engine: hard-rule violations are denied and never reach PayPal', async () => {
  const e = makeEngine();
  let payouts = 0;
  const orig = e.paypal.createPayout.bind(e.paypal);
  e.paypal.createPayout = (...a) => { payouts++; return orig(...a); };
  const { mandate } = await e.createMandate(mandateInput());
  const cases = [
    [{ amount: '150.00' }, 'per_tx'],
    [{ payee: 'ops@other.example' }, 'allowlist'],
    [{ category: 'travel' }, 'category'],
    [{ currency: 'EUR' }, 'currency'],
  ];
  for (const [over, failedId] of cases) {
    const r = await e.submitPayment(mandate.id, payInput(over));
    assert.equal(r.status, 'denied', JSON.stringify(over));
    assert.ok(r.decision.policy.checks.some((c) => c.id === failedId && !c.pass), failedId);
  }
  assert.equal(payouts, 0);
});

test('engine: above the threshold waits for a human, then pays', async () => {
  const e = makeEngine();
  const { mandate } = await e.createMandate(mandateInput());
  const r = await e.submitPayment(mandate.id, payInput({ amount: '75.00', purpose: 'Annual dataset licence', evidence: 'Quote 9 for dataset licence 75 USD' }));
  assert.equal(r.status, 'pending_approval');
  const done = await e.approve(r.id);
  assert.equal(done.status, 'executed');
  await assert.rejects(() => e.approve(r.id), /not pending/);
});

test('engine: human rejection ends the request', async () => {
  const e = makeEngine();
  const { mandate } = await e.createMandate(mandateInput());
  const r = await e.submitPayment(mandate.id, payInput({ amount: '75.00' }));
  assert.equal((await e.reject(r.id)).status, 'rejected');
});

test('engine: approval re-checks hard rules (budget spent meanwhile → denied)', async () => {
  const e = makeEngine();
  const { mandate } = await e.createMandate(mandateInput({ budget: '120', perTx: '100', approvalOver: '30' }));
  const big = await e.submitPayment(mandate.id, payInput({ amount: '90.00', purpose: 'Dataset A bulk licence', evidence: 'quote dataset 90' }));
  assert.equal(big.status, 'pending_approval');
  const small = await e.submitPayment(mandate.id, payInput({ amount: '25.00', purpose: 'Dataset B sample pack' }));
  assert.equal(small.status, 'executed');
  const re = await e.approve(big.id); // 25 spent, only 95 left but... 90 <= 95 still ok
  assert.equal(re.status, 'executed');
  const again = await e.submitPayment(mandate.id, payInput({ amount: '25.00', purpose: 'Dataset C more rows' }));
  assert.equal(again.status, 'denied');
  assert.ok(again.decision.policy.checks.find((c) => c.id === 'budget' && !c.pass));
});

test('engine: concurrent agents cannot race past the budget', async () => {
  const e = makeEngine();
  const { mandate } = await e.createMandate(mandateInput({ budget: '100', perTx: '60', approvalOver: '60' }));
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => e.submitPayment(mandate.id, payInput({ amount: '60.00', purpose: `Dataset batch number ${i}`, evidence: 'dataset invoice' }))));
  assert.equal(rs.filter((r) => r.status === 'executed').length, 1);
  assert.ok(e.mandateView(e.mandate(mandate.id)).spentCents <= 10000);
});

test('engine: duplicate requests are blocked', async () => {
  const e = makeEngine();
  const { mandate } = await e.createMandate(mandateInput());
  assert.equal((await e.submitPayment(mandate.id, payInput())).status, 'executed');
  const dup = await e.submitPayment(mandate.id, payInput());
  assert.equal(dup.status, 'denied');
  assert.ok(dup.decision.policy.checks.find((c) => c.id === 'duplicate' && !c.pass));
});

test('engine: budget window rolls over with time', async () => {
  const e = makeEngine();
  const { mandate } = await e.createMandate(mandateInput({ budget: '60', perTx: '60', approvalOver: '60', period: 'day' }));
  assert.equal((await e.submitPayment(mandate.id, payInput({ amount: '60.00' }))).status, 'executed');
  assert.equal((await e.submitPayment(mandate.id, payInput({ amount: '10.00', purpose: 'Another dataset' }))).status, 'denied');
  e.clock.t += 25 * 3600_000;
  assert.equal((await e.submitPayment(mandate.id, payInput({ amount: '10.00', purpose: 'Another dataset again' }))).status, 'executed');
});

test('engine: revoked and expired mandates stop everything', async () => {
  const e = makeEngine();
  const { mandate } = await e.createMandate(mandateInput());
  await e.revokeMandate(mandate.id);
  assert.equal((await e.submitPayment(mandate.id, payInput())).status, 'denied');
  const e2 = makeEngine();
  const m2 = (await e2.createMandate(mandateInput())).mandate;
  e2.clock.t += 40 * 86_400_000;
  const r = await e2.submitPayment(m2.id, payInput());
  assert.equal(r.status, 'denied');
  assert.ok(r.decision.policy.checks.find((c) => c.id === 'expiry' && !c.pass));
});

test('engine: a tampered mandate in storage is rejected by the signature check', async () => {
  const e = makeEngine();
  const { mandate } = await e.createMandate(mandateInput());
  e.state.mandates[mandate.id].perTxCents = 10_000_000; // attacker edits the stored file
  e.state.mandates[mandate.id].budgetCents = 10_000_000;
  const r = await e.submitPayment(mandate.id, payInput({ amount: '150.00' }));
  assert.equal(r.status, 'denied');
  assert.ok(r.decision.policy.checks.find((c) => c.id === 'signature' && !c.pass));
});

test('engine: PayPal failure is recorded, not hidden', async () => {
  const e = makeEngine();
  const { mandate } = await e.createMandate(mandateInput({ payees: [] }));
  e.paypal.createPayout = async () => { throw new Error('PayPal boom'); };
  // no allowlist → first payee escalates; approve it so the payout is attempted
  const r = await e.submitPayment(mandate.id, payInput());
  const done = await e.approve(r.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /boom/);
  assert.ok(e.state.ledger.some((l) => l.type === 'payment.failed'));
});
