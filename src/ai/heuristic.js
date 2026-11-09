import { CATEGORIES } from '../mandate.js';
import { toCents } from '../money.js';

// Offline, deterministic "AI" reviewer. It is the always-on baseline (and the fallback when no LLM key is set).
// When Claude is configured, both run and the STRICTER verdict wins.

export const INJECTION = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|polic\w+|limits?)/i,
  /disregard\s+.{0,40}(polic\w+|rules?|limits?|mandate)/i,
  /\b(system|developer)\s*(prompt|message|override)\b/i,
  /you\s+are\s+now\b/i,
  /\b(override|bypass|skip)\b.{0,30}(approval|check|polic\w+|limit|review|verification)/i,
  /do\s+not\s+(tell|notify|alert|inform|ask)\b/i,
  /\bnew\s+(bank|payment|account|payout)\s+(details|instructions|info)\b/i,
  /\bpre-?authori[sz]ed\b/i,
  /\b(approve|pay|release)\s+(this\s+)?(automatically|immediately|without)/i,
  /\bmark\s+(this\s+|it\s+|the\s+)?(\w+\s+)?(as\s+)?(complete|completed|done|delivered|approved|paid)\b/i,
  /\bignore\s+(the\s+)?(acceptance\s+)?(criteria|requirements|checks?)\b/i,
  /\brelease\s+(the\s+)?(payment|funds|money)\s+(now|immediately)\b/i,
  /\bthe\s+owner\s+(already\s+)?(approved|authori[sz]ed)\b/i,
  /\b(as|i am)\s+the\s+(owner|admin|ceo|cfo)\b/i,
];
const URGENCY = /\b(urgent|immediately|asap|right now|final notice|last chance|account (will be )?(suspended|closed)|within \d+ (minutes?|hours?))\b/i;

const LEXICON = {
  data: ['dataset', 'data', 'corpus', 'labels', 'labelled', 'labeled', 'annotation', 'scrape', 'scraping'],
  software: ['api', 'license', 'licence', 'saas', 'subscription', 'hosting', 'cloud', 'domain', 'tool', 'plugin', 'credits', 'compute'],
  research: ['paper', 'study', 'survey', 'research', 'report', 'journal', 'analysis'],
  design: ['logo', 'design', 'figma', 'illustration', 'mockup', 'banner', 'icon'],
  writing: ['article', 'copy', 'blog', 'translation', 'editing', 'proofread', 'content'],
  marketing: ['ads', 'campaign', 'seo', 'promotion', 'influencer', 'newsletter'],
  travel: ['flight', 'hotel', 'booking', 'visa', 'train', 'airbnb'],
  contractor: ['freelance', 'contractor', 'gig', 'invoice', 'development', 'milestone', 'consulting'],
};

const STOP = new Set('with that this from have will your their about into than then them they been being were what when which while should would could there these those also must each over under such only more most some very just like make made using used within without'.split(' '));
const stem = (w) => (w.length > 3 ? w.toLowerCase().replace(/(ing|ed|es|s|e)$/, '') : w.toLowerCase());
const words = (t) => (String(t).toLowerCase().match(/[a-z0-9$]+/g) || []);

export const hasInjection = (text) => INJECTION.filter((re) => re.test(String(text || '')));

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
const deHomoglyph = (s) => s.replace(/rn/g, 'm').replace(/[1|]/g, 'l').replace(/0/g, 'o').replace(/vv/g, 'w');

export function lookalike(payee, known) {
  const host = (e) => e.split('@').pop();
  const p = host(payee.toLowerCase());
  for (const k of known) {
    const h = host(k.toLowerCase());
    if (h === p) continue;
    if (deHomoglyph(h) === deHomoglyph(p) || (levenshtein(h, p) <= 2 && Math.min(h.length, p.length) > 6)) return h;
  }
  return null;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Review a payment request. Returns {risk 0-100, flags[], recommendation: allow|escalate|deny, rationale}. */
export function reviewRequest({ mandate, request, state }) {
  const flags = [];
  const add = (id, weight, detail) => flags.push({ id, weight, detail });
  const text = `${request.purpose || ''}\n${request.evidence || ''}`;

  const inj = hasInjection(text);
  if (inj.length) add('prompt_injection', 80, `Request text tries to instruct the reviewer / change rules ("${text.match(inj[0])?.[0]}")`);
  if (URGENCY.test(text)) add('pressure_language', 20, 'Urgency / pressure language is a classic social-engineering signal');

  const lc = text.toLowerCase();
  const scores = Object.entries(LEXICON).map(([cat, kws]) => [cat, kws.filter((k) => new RegExp(`\\b${k}`).test(lc)).length]).sort((a, b) => b[1] - a[1]);
  if (scores[0][1] === 0) add('vague_purpose', 12, 'Purpose does not describe what is being bought');
  else if (request.category !== 'other' && scores[0][0] !== request.category && !scores.some(([c, n]) => c === request.category && n > 0)) {
    add('category_mismatch', 28, `Declared "${request.category}" but the description reads like "${scores[0][0]}"`);
  }

  const known = [...mandate.payees, ...Object.values(state.requests).filter((r) => r.mandateId === mandate.id && r.status === 'executed').map((r) => r.payee)];
  const la = lookalike(request.payee, known);
  if (la) add('lookalike_payee', 55, `Payee domain looks like known "${la}" but is different`);

  const hist = Object.values(state.requests).filter((r) => r.mandateId === mandate.id && r.status === 'executed').map((r) => r.amountCents);
  if (hist.length >= 3 && request.amountCents > 4 * median(hist)) add('amount_outlier', 22, `Amount is >4× the median of past payments`);
  if (request.amountCents >= mandate.perTxCents * 0.25 && !String(request.evidence || '').trim()) add('missing_evidence', 10, 'Sizeable payment without supporting evidence (invoice/quote)');

  const risk = Math.min(100, flags.reduce((s, f) => s + f.weight, 0));
  const recommendation = risk >= 60 ? 'deny' : risk >= 30 ? 'escalate' : 'allow';
  const rationale = flags.length ? flags.map((f) => f.detail).join('; ') : 'No risk signals: purpose, category, payee and amount are consistent with the mandate.';
  return { provider: 'heuristic', risk, flags, recommendation, rationale };
}

const sig = (criterion) => [...new Set(words(criterion).filter((w) => w.length > 3 && !STOP.has(w)).map(stem))];

/** Check a milestone deliverable against its acceptance criteria. */
export function verifyDeliverable({ criteria, deliverable }) {
  const text = String(deliverable || '');
  const toks = new Set(words(text).map(stem));
  const met = [];
  const unmet = [];
  for (const c of criteria) {
    const ks = sig(c);
    const hit = ks.filter((k) => toks.has(k)).length;
    (ks.length === 0 || hit / ks.length >= 0.6 ? met : unmet).push(c);
  }
  const score = criteria.length ? met.length / criteria.length : 0;
  const inj = hasInjection(text);
  const flags = [];
  if (inj.length) flags.push({ id: 'prompt_injection', detail: `Deliverable tries to instruct the verifier ("${text.match(inj[0])?.[0]}")` });
  if (text.trim().length < 40) flags.push({ id: 'too_short', detail: 'Deliverable is too short to evaluate' });
  let recommendation = score >= 0.8 ? 'release' : score >= 0.5 ? 'partial' : 'reject';
  if (flags.length) recommendation = 'reject';
  return {
    provider: 'heuristic', score: Math.round(score * 100) / 100, met, unmet, flags, recommendation,
    rationale: flags.length ? flags.map((f) => f.detail).join('; ') : `${met.length}/${criteria.length} acceptance criteria evidenced in the deliverable`,
  };
}

/** Turn plain English into mandate fields. Deterministic parser (LLM version lives in anthropic.js). */
export function draftMandate(text) {
  const t = String(text || '');
  const money = [...t.matchAll(/(?:\$|usd\s*)\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|usd|\$)/gi)].map((m) => m[1] || m[2]).map((s) => s.replace(/,/g, ''));
  if (!money.length) throw new Error('Could not find a dollar amount in the description');
  const budget = money[0];
  const grab = (re) => { const m = t.match(re); return m ? (m[1] || m[2]).replace(/,/g, '') : null; };
  const perTx = grab(/(?:no more than|max(?:imum)?|up to|limit(?:ed)? to)\s*\$?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:per|each|a|\/)\s*(?:transaction|purchase|payment|order|item)/i) ?? grab(/(?:per|each)\s*(?:transaction|purchase|payment)[^$\d]{0,20}\$?(\d[\d,]*(?:\.\d{1,2})?)/i);
  const approvalOver = grab(/(?:ask me|approval|confirm|check with me)[^$\d]{0,40}(?:over|above|more than|exceeding|for)\s*\$?(\d[\d,]*(?:\.\d{1,2})?)/i) ?? grab(/(?:over|above|more than)\s*\$?(\d[\d,]*(?:\.\d{1,2})?)[^.]{0,30}(?:ask|approval|confirm)/i);
  const period = /\b(per|a|each|every)\s+day\b|\bdaily\b/i.test(t) ? 'day' : /\b(per|a|each|every)\s+week\b|\bweekly\b/i.test(t) ? 'week' : /\b(per|a|each|every)\s+month\b|\bmonthly\b/i.test(t) ? 'month' : 'total';
  const cats = CATEGORIES.filter((c) => c !== 'other' && (new RegExp(`\\b${c}s?\\b`, 'i').test(t) || LEXICON[c]?.some((k) => new RegExp(`\\b${k}s?\\b`, 'i').test(t))));
  const payees = [...new Set([...(t.match(/@?[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []), ...(t.match(/(?<![\w.])@[\w-]+(?:\.[\w-]+)+/g) || [])].map((p) => p.toLowerCase()))];
  const agent = `${(t.match(/(?:my|the)\s+([\w -]{2,30}?)\s+agent/i)?.[1] || 'AI').trim()} agent`;
  const days = t.match(/for\s+(?:the\s+next\s+)?(\d+)\s+(day|week|month)s?/i);
  const expiresAt = days ? new Date(Date.now() + Number(days[1]) * { day: 1, week: 7, month: 30 }[days[2].toLowerCase()] * 86_400_000).toISOString() : undefined;
  const bc = toCents(budget);
  const pc = perTx ? toCents(perTx) : bc;
  return {
    provider: 'heuristic',
    mandate: {
      agent: agent.replace(/\b\w/g, (c) => c.toUpperCase()), budget, period, perTx: (pc / 100).toFixed(2),
      // Conservative default: ask a human above half of the per-transaction limit.
      approvalOver: approvalOver && toCents(approvalOver) <= pc ? approvalOver : (Math.floor(pc / 2) / 100).toFixed(2),
      categories: cats.length ? cats : ['other'], payees, expiresAt,
    },
  };
}

/** Triage a refund request (customer- or agent-initiated). Same output shape as reviewRequest. */
export function triageRefund({ order, reason, amountCents, history }) {
  const flags = [];
  const add = (id, weight, detail) => flags.push({ id, weight, detail });
  const text = String(reason || '');
  const inj = hasInjection(text);
  if (inj.length) add('prompt_injection', 80, `Reason text tries to instruct the reviewer ("${text.match(inj[0])?.[0]}")`);
  if (/\b(chargeback|sue|lawyer|legal action|paypal claim|dispute this)\b/i.test(text)) add('abuse_threat', 25, 'Threat of chargeback/legal action is a pressure tactic');
  if (history >= 2) add('serial_refunder', 30, `Customer already has ${history} refunds`);
  if (amountCents > 10_000) add('high_value', 20, 'High-value refund');
  if (text.trim().length < 15) add('vague_reason', 25, 'Reason is too short to evaluate');
  if (/\b(changed my mind|don'?t want|no longer need|not needed)\b/i.test(text) && order.digital) add('digital_change_of_mind', 25, 'Digital goods, change-of-mind');
  const valid = /\b(defect\w*|broken|not as described|duplicate|wrong item|not received|never arrived|damaged|charged twice|double charged|does not work|doesn'?t work|corrupt\w*)\b/i.test(text);
  const risk = Math.max(0, Math.min(100, flags.reduce((s, f) => s + f.weight, 0) - (valid ? 10 : 0)));
  const recommendation = risk >= 60 ? 'deny' : risk >= 20 ? 'escalate' : 'allow';
  const rationale = flags.length ? flags.map((f) => f.detail).join('; ') + (valid ? '; stated reason is a recognised valid cause' : '') : valid ? 'Reason is a recognised valid cause; no risk signals.' : 'No risk signals.';
  return { provider: 'heuristic', risk, flags, recommendation, rationale };
}
