import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env loader (no dependency). Real environment variables win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^['"]|['"]$/g, '');
    if (process.env[m[1]] === undefined && val !== '') process.env[m[1]] = val;
  }
}

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 8787);
  return {
    port,
    host: env.HOST || '127.0.0.1',
    publicUrl: env.PUBLIC_URL || `http://localhost:${port}`,
    mandateSecret: env.MANDATE_SECRET || 'dev-only-secret-change-me',
    dataFile: env.DATA_FILE === '' ? null : path.resolve(ROOT, env.DATA_FILE || 'data/state.json'),
    demoPayee: env.DEMO_PAYEE_EMAIL || 'ops@dataset-hub.example',
    merchantEmail: env.PAYPAL_PAYEE_EMAIL || 'shop@merchant.example',
    adminToken: env.ADMIN_TOKEN || '',
    authDisabled: env.AUTH_DISABLED === '1',
    plans: { pro: env.PAYPAL_PLAN_PRO || '', scale: env.PAYPAL_PLAN_SCALE || '' },
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    trustProxy: env.TRUST_PROXY === '1',
    demoMode: env.DEMO_MODE !== '0',
    paypal: {
      clientId: env.PAYPAL_CLIENT_ID || '',
      clientSecret: env.PAYPAL_CLIENT_SECRET || '',
      payeeEmail: env.PAYPAL_PAYEE_EMAIL || '',
    },
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    },
  };
}

export function bootstrapEnv() {
  loadDotEnv(path.join(ROOT, '.env'));
  return loadConfig();
}
