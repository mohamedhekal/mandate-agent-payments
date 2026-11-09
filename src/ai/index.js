import * as heuristic from './heuristic.js';
import { AnthropicReviewer } from './anthropic.js';
import { strictest } from '../policy.js';

const REL = { release: 0, partial: 1, reject: 2 };

/**
 * Defense in depth: the deterministic heuristic ALWAYS runs. If a Claude key is configured it runs too,
 * and the stricter result wins. If Claude errors/times out we degrade to the heuristic (and say so).
 */
export function createAI(config, { llm } = {}) {
  const claude = llm || (config.anthropic.apiKey ? new AnthropicReviewer(config.anthropic) : null);
  const name = claude ? `claude (${config.anthropic.model}) + heuristic` : 'heuristic (offline)';

  return {
    name,
    llmEnabled: !!claude,

    async reviewRequest(ctx, { skipLLM = false } = {}) {
      const base = heuristic.reviewRequest(ctx);
      if (!claude || skipLLM) return { ...base, reviewers: [base.provider] };
      try {
        const history = Object.values(ctx.state.requests).filter((r) => r.mandateId === ctx.mandate.id && r.status === 'executed').slice(-5).map((r) => ({ payee: r.payee, amount: r.amountCents / 100, purpose: r.purpose }));
        const l = await claude.reviewRequest({ ...ctx, history });
        const rec = strictest(base.recommendation, l.recommendation);
        return { provider: 'combined', risk: Math.max(base.risk, l.risk), flags: [...base.flags, ...l.flags], recommendation: rec, rationale: `${l.rationale} | heuristic: ${base.rationale}`, reviewers: [base.provider, l.provider] };
      } catch (err) {
        return { ...base, reviewers: [base.provider], llmError: String(err.message) };
      }
    },

    async verifyDeliverable(ctx) {
      const base = heuristic.verifyDeliverable(ctx);
      if (!claude) return { ...base, reviewers: [base.provider] };
      try {
        const l = await claude.verifyDeliverable(ctx);
        const rec = REL[l.recommendation] >= REL[base.recommendation] ? l.recommendation : base.recommendation;
        return { provider: 'combined', score: Math.min(base.score, l.score), met: l.met, unmet: [...new Set([...base.unmet, ...l.unmet])], flags: base.flags, recommendation: rec, rationale: `${l.rationale} | heuristic: ${base.rationale}`, reviewers: [base.provider, l.provider] };
      } catch (err) {
        return { ...base, reviewers: [base.provider], llmError: String(err.message) };
      }
    },

    async triageRefund(ctx) {
      const base = heuristic.triageRefund(ctx);
      if (!claude) return { ...base, reviewers: [base.provider] };
      try {
        const l = await claude.triageRefund(ctx);
        return { provider: 'combined', risk: Math.max(base.risk, l.risk), flags: [...base.flags, ...l.flags], recommendation: strictest(base.recommendation, l.recommendation), rationale: `${l.rationale} | heuristic: ${base.rationale}`, reviewers: [base.provider, l.provider] };
      } catch (err) {
        return { ...base, reviewers: [base.provider], llmError: String(err.message) };
      }
    },

    async answer(question, metrics, fallback) {
      if (claude) {
        try { return { text: await claude.answer(question, metrics), provider: 'claude' }; } catch { /* fall through */ }
      }
      return { text: fallback(question, metrics), provider: 'heuristic' };
    },

    async draftMandate(text) {
      if (claude) {
        try { return await claude.draftMandate(text); } catch { /* fall through */ }
      }
      return heuristic.draftMandate(text);
    },
  };
}
