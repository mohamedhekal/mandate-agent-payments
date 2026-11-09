import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { PayPalSimulator } from '../src/paypal/simulator.js';
import { createAI } from '../src/ai/index.js';
import { Engine } from '../src/engine.js';

export function makeEngine({ llm, paypal, now } = {}) {
  const config = { ...loadConfig({}), mandateSecret: 'test-secret', dataFile: null, authDisabled: true, adminToken: 'test-admin-token', demoMode: true };
  const clock = { t: Date.parse('2026-11-09T12:00:00Z') };
  const engine = new Engine({
    store: new Store(null),
    paypal: paypal || new PayPalSimulator(),
    ai: createAI(config, { llm }),
    config,
    now: now || (() => clock.t),
  });
  engine.clock = clock;
  return engine;
}

export const mandateInput = (over = {}) => ({
  owner: 'me', agent: 'Test Agent', budget: '200', period: 'week', perTx: '100', approvalOver: '50',
  categories: ['data', 'software', 'contractor'], payees: ['@vendor.example', 'designer@studio.example'], ...over,
});

export const payInput = (over = {}) => ({
  payee: 'ops@vendor.example', amount: '20.00', category: 'data', purpose: 'Labelled dataset for benchmark', evidence: 'Invoice 12: 20 USD dataset', ...over,
});
