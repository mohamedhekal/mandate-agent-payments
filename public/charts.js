// Dependency-free SVG/HTML chart helpers. Colours are CSS variables, so charts follow light/dark automatically.
// CSP forbids inline style attributes: dynamic colours/sizes are carried in data-* attributes and applied by applyDyn() in app.js.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const usd = (c) => `$${(c / 100).toFixed(2)}`;
const short = (c) => (Math.abs(c) >= 100000 ? `$${(c / 100000).toFixed(1)}k` : `$${Math.round(c / 100)}`);
export const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];

/** Daily money chart: revenue bars + agent-spend and blocked lines. */
export function moneyChart(series) {
  const W = 720; const H = 230; const L = 40; const B = 26; const T = 10; const R = 8;
  // Scale to revenue/agent spend; one huge blocked amount must not flatten everything else, so it is clipped with a marker.
  const max = Math.max(100, ...series.map((d) => Math.max(d.revenueCents, d.agentSpendCents)));
  const nice = Math.max(1000, Math.ceil((max * 1.3) / 1000) * 1000);
  const x = (i) => L + ((W - L - R) / series.length) * (i + 0.5);
  const y = (v) => T + (H - T - B) * (1 - Math.min(v, nice) / nice);
  const bw = Math.max(3, Math.min(22, ((W - L - R) / series.length) * 0.58));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * nice);
  const line = (key, color) => `<polyline fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${series.map((d, i) => `${x(i)},${y(d[key])}`).join(' ')}"/>`;
  const every = Math.ceil(series.length / 8);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily store revenue, agent spend and blocked amounts">
    ${ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${short(t)}</text>`).join('')}
    ${series.map((d, i) => `<rect x="${x(i) - bw / 2}" y="${y(d.revenueCents)}" width="${bw}" height="${Math.max(0, y(0) - y(d.revenueCents))}" rx="3" fill="var(--c1)" opacity=".85"><title>${esc(d.day)}: revenue ${usd(d.revenueCents)}, agents ${usd(d.agentSpendCents)}, blocked ${usd(d.blockedCents)}</title></rect>`).join('')}
    ${line('agentSpendCents', 'var(--c2)')}${line('blockedCents', 'var(--c4)')}
    ${series.map((d, i) => (d.blockedCents > nice ? `<path d="M${x(i) - 5} ${T + 12} L${x(i)} ${T + 2} L${x(i) + 5} ${T + 12}z" fill="var(--c4)"><title>${esc(d.day)}: blocked ${usd(d.blockedCents)} (above chart scale)</title></path>` : '')).join('')}
    ${series.map((d, i) => (i % every === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(d.day.slice(5))}</text>` : '')).join('')}
  </svg>
  <div class="legend"><span><i data-bg="var(--c1)"></i>Store revenue</span><span><i data-bg="var(--c2)"></i>Agent spend</span><span><i data-bg="var(--c4)"></i>Blocked by Mandate</span></div>`;
}

export function donut(items, centerLabel) {
  const total = items.reduce((s, i) => s + i.cents, 0);
  if (!total) return '<div class="hint">No spend in this period.</div>';
  const r = 52; const C = 2 * Math.PI * r;
  let off = 0;
  const segs = items.slice(0, 6).map((it, i) => {
    const len = (it.cents / total) * C;
    const s = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${COLORS[i]}" stroke-width="20" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"><title>${esc(it.key)}: ${usd(it.cents)}</title></circle>`;
    off += len;
    return s;
  }).join('');
  return `<div class="donutwrap"><svg class="donut" width="150" height="150" viewBox="0 0 140 140" role="img" aria-label="Spend breakdown">${segs}<text x="70" y="68" text-anchor="middle" font-size="17">${usd(total)}</text><text x="70" y="84" text-anchor="middle" font-size="9" fill="var(--muted)">${esc(centerLabel)}</text></svg>
  <div class="hbars">${items.slice(0, 6).map((it, i) => `<div class="hb"><span><i class="dotc" data-bg="${COLORS[i]}"></i>${esc(it.key)}</span><span></span><b>${usd(it.cents)} · ${Math.round((it.cents / total) * 100)}%</b></div>`).join('')}</div></div>`;
}

export function hbars(items, { fmtv = usd, klass = '' } = {}) {
  if (!items.length) return '<div class="hint">Nothing to show for this period.</div>';
  const max = Math.max(1, ...items.map((i) => i.cents ?? i.count));
  return `<div class="hbars">${items.map((it) => { const v = it.cents ?? it.count; return `<div class="hb"><span title="${esc(it.key)}">${esc(it.key)}</span><span class="bar"><i class="${klass}" data-w="${Math.max(3, Math.round((v / max) * 100))}"></i></span><b>${fmtv(v)}</b></div>`; }).join('')}</div>`;
}

export function stacked(parts) {
  const total = parts.reduce((s, p) => s + p.n, 0) || 1;
  return `<div class="stack" role="img" aria-label="${parts.map((p) => `${p.label} ${p.n}`).join(', ')}">${parts.map((p) => `<i class="${p.cls}" data-w="${(p.n / total) * 100}" title="${esc(p.label)}: ${p.n}"></i>`).join('')}</div>
  <div class="legend">${parts.map((p) => `<span><i data-bg="${p.color}"></i>${esc(p.label)} <b>${p.n}</b></span>`).join('')}</div>`;
}

export function histogram(bins) {
  const max = Math.max(1, ...bins);
  const labels = ['0–19', '20–39', '40–59', '60–79', '80–100'];
  return `<div class="hist" role="img" aria-label="Distribution of AI risk scores">${bins.map((n, i) => `<div class="h${i}"><b>${n}</b><i data-h="${Math.round((n / max) * 100)}"></i><span>${labels[i]}</span></div>`).join('')}</div>`;
}
