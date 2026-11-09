#!/usr/bin/env node
// Minimal MCP (Model Context Protocol) server over stdio — zero dependencies.
// It gives ANY MCP-capable agent (Claude Desktop, Claude Code, Cursor...) governed payment tools.
// The agent only holds a per-mandate token; it can ask to pay but can never approve itself.
//
//   MANDATE_URL=http://localhost:8787  MANDATE_AGENT_TOKEN=mat_...  node src/mcp.js
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const TOOLS = [
  {
    name: 'get_mandate_status',
    description: 'Show your spending mandate: remaining budget, per-transaction limit, allowed categories/payees and the amount above which a human must approve.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'request_payment',
    description: 'Ask to pay someone (PayPal Payout, sandbox). The request is checked against your mandate and an AI risk reviewer. Result is "executed", "pending_approval" (a human must approve) or "denied" with reasons. Never retry a denied payment with altered wording.',
    inputSchema: {
      type: 'object',
      properties: {
        payee: { type: 'string', description: 'Recipient PayPal email' },
        amount: { type: 'string', description: 'Amount, e.g. "18.00"' },
        currency: { type: 'string', default: 'USD' },
        category: { type: 'string', enum: ['data', 'software', 'research', 'design', 'writing', 'marketing', 'travel', 'contractor', 'other'] },
        purpose: { type: 'string', description: 'What you are buying and why' },
        evidence: { type: 'string', description: 'Invoice / quote text supporting the payment' },
      },
      required: ['payee', 'amount', 'category', 'purpose'],
    },
  },
  {
    name: 'list_catalog',
    description: 'List products you can buy from the PayPal-checkout store (prices are fixed server-side).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'purchase_item',
    description: 'Buy a catalog item under your mandate. Checked by hard rules + AI review; the price always comes from the catalog.',
    inputSchema: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['sku'] },
  },
  {
    name: 'create_escrow',
    description: 'Hire a contractor with milestone escrow: funds are authorised once and released per milestone only after an AI verifier confirms the acceptance criteria.',
    inputSchema: {
      type: 'object',
      properties: {
        payee: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, purpose: { type: 'string' },
        milestones: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } } }, required: ['name', 'amount', 'criteria'] } },
      },
      required: ['payee', 'title', 'category', 'milestones'],
    },
  },
  {
    name: 'submit_deliverable',
    description: 'Submit completed work for an escrow milestone so the verifier can release payment.',
    inputSchema: { type: 'object', properties: { escrowId: { type: 'string' }, milestoneId: { type: 'string' }, deliverable: { type: 'string' } }, required: ['escrowId', 'milestoneId', 'deliverable'] },
  },
];

export function createHandler({ baseUrl, token, fetchImpl = fetch }) {
  const api = async (method, p, body) => {
    const res = await fetchImpl(`${baseUrl}/api/agent${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  };
  const summarize = (r) => (r.decision
    ? { id: r.id, status: r.status, decision: r.decision.final, decidedBy: r.decision.decidedBy, failedChecks: r.decision.failedChecks, aiRationale: r.decision.ai.rationale, paypal: r.paypal, approveUrl: r.paypal?.approveUrl }
    : r);

  const call = async (name, args = {}) => {
    switch (name) {
      case 'get_mandate_status': return api('GET', '/mandate');
      case 'request_payment': return summarize(await api('POST', '/payments', args));
      case 'list_catalog': return api('GET', '/catalog');
      case 'purchase_item': return summarize(await api('POST', '/purchase', args));
      case 'create_escrow': return summarize(await api('POST', '/escrows', args));
      case 'submit_deliverable': return api('POST', `/escrows/${encodeURIComponent(args.escrowId)}/deliver`, { milestoneId: args.milestoneId, deliverable: args.deliverable });
      default: throw new Error(`unknown tool ${name}`);
    }
  };

  return async function handle(msg) {
    const { id, method, params } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': return ok({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mandate-payments', version: '1.0.0' } });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call':
        try {
          const out = await call(params?.name, params?.arguments);
          return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        } catch (e) {
          return ok({ isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] });
        }
      default:
        if (id === undefined) return null; // notification
        return err(-32601, `method not found: ${method}`);
    }
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const handle = createHandler({ baseUrl: process.env.MANDATE_URL || 'http://localhost:8787', token: process.env.MANDATE_AGENT_TOKEN || '' });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const out = await handle(msg);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
