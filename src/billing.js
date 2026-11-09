// The SaaS layer: plan tiers + usage metering. Plan changes go through PayPal Subscriptions.
export const PLANS = {
  free: { id: 'free', name: 'Starter', priceCents: 0, agents: 3, requestsPerMonth: 300, features: ['3 agent mandates', '300 governed requests / month', 'Heuristic AI review'] },
  pro: { id: 'pro', name: 'Pro', priceCents: 2900, agents: 25, requestsPerMonth: 10_000, features: ['25 agent mandates', '10,000 requests / month', 'Claude + heuristic review', 'Escrow & refunds triage'] },
  scale: { id: 'scale', name: 'Scale', priceCents: 9900, agents: 250, requestsPerMonth: 250_000, features: ['250 agent mandates', '250,000 requests / month', 'Priority webhooks', 'Audit export'] },
};

export const monthKey = (t) => new Date(t).toISOString().slice(0, 7);

export function usageOf(tenant, now) {
  const plan = PLANS[tenant.plan] || PLANS.free;
  const used = tenant.meter[monthKey(now)] || 0;
  return { plan, used, remaining: Math.max(0, plan.requestsPerMonth - used) };
}
