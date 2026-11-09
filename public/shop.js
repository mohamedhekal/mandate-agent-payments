import { icon, mark } from './icons.js';
const $ = (s) => document.querySelector(s);
document.querySelectorAll('.brandmark').forEach((e) => { e.innerHTML = mark(Number(e.dataset.size) || 36); });
const CAT_ICON = { data: 'coins', software: 'zap', research: 'scroll', design: 'pen', writing: 'receipt' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (c) => `$${(c / 100).toFixed(2)}`;
let selected = null;
let order = null;

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3500);
}

const STATUS = { awaiting_buyer: 'Awaiting PayPal approval', paid: 'Paid', partially_refunded: 'Partially refunded', refunded: 'Refunded', failed: 'Failed' };
const RSTATUS = { refunded: 'Refunded', pending_approval: 'Waiting for the merchant', denied: 'Declined', failed: 'Failed' };

async function load() {
  const d = await api('GET', '/api/shop/catalog');
  $('#mode').textContent = d.paypal === 'sandbox-live' ? 'PayPal sandbox · live' : 'PayPal sandbox · simulated';
  $('#products').innerHTML = d.catalog.map((p) => `<button class="product" data-sku="${esc(p.sku)}" data-name="${esc(p.name)}" data-price="${p.priceCents}"><span class="art">${icon(CAT_ICON[p.category] || 'package', 34)}<span class="chip">${esc(p.category)}</span></span><span class="info"><b>${esc(p.name)}</b><span class="hint">${p.digital ? 'Instant delivery' : 'Delivered by the studio'}</span><span class="price">${usd(p.priceCents)}</span></span></button>`).join('');
}

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('.product');
  if (b) {
    selected = { sku: b.dataset.sku, name: b.dataset.name, price: Number(b.dataset.price) };
    document.querySelectorAll('.product').forEach((x) => x.classList.toggle('on', x === b));
    $('#selected').textContent = `${selected.name} — ${usd(selected.price)}`;
    $('#buy').disabled = false;
  }
  const act = ev.target.closest('[data-act]');
  if (act) run(act.dataset.act);
});

async function run(act) {
  const email = $('#email').value;
  try {
    if (act === 'pay') order = await api('POST', `/api/shop/orders/${order.id}/pay`, { email });
    if (act === 'refund') {
      const reason = $('#reason').value;
      const r = await api('POST', `/api/shop/orders/${order.id}/refund`, { email, reason });
      toast(`Refund: ${RSTATUS[r.status] || r.status}`);
      order = await api('GET', `/api/shop/orders/${order.id}?email=${encodeURIComponent(email)}`);
    }
    renderOrder();
  } catch (e) { toast(`⚠ ${e.message}`); }
}

$('#orderForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!selected) return;
  try {
    order = await api('POST', '/api/shop/orders', { sku: selected.sku, qty: 1, customerEmail: $('#email').value });
    renderOrder();
  } catch (e) { toast(`⚠ ${e.message}`); }
});

function renderOrder() {
  const box = $('#orderBox');
  box.hidden = false;
  const o = order;
  const live = o.approveUrl && !o.approveUrl.includes('#simulated');
  box.innerHTML = `<div class="item ${o.status === 'paid' ? 'executed' : ''}">
    <div class="item-h"><div><b>${esc(o.items[0].name)}</b><br><span class="hint">Order ${esc(o.id)} · ${usd(o.totalCents)}</span></div><span class="pill ${o.status === 'paid' ? 'ok' : o.status === 'failed' ? 'bad' : 'warn'}">${esc(STATUS[o.status] || o.status)}</span></div>
    ${o.status === 'awaiting_buyer' ? `<div class="actions">${live ? `<a class="btn primary" href="${esc(o.approveUrl)}">Approve in PayPal sandbox ↗</a>` : `<button class="btn primary" data-act="pay">${icon('card', 16)}Pay with PayPal (sandbox)</button>`}</div>` : ''}
    ${['paid', 'partially_refunded'].includes(o.status) ? `<label for="reason">Need a refund? Tell us why</label><textarea id="reason" rows="2" placeholder="e.g. I was charged twice"></textarea><div class="actions"><button class="btn" data-act="refund">Request refund</button></div>` : ''}
    ${(o.refunds || []).map((r) => `<p class="hint">Refund ${usd(r.amountCents)}: <b>${esc(RSTATUS[r.status] || r.status)}</b></p>`).join('')}
  </div>`;
}

const params = new URLSearchParams(location.search);
load().catch((e) => toast(`⚠ ${e.message}`));
if (params.get('order')) toast('Returned from PayPal — enter your email and look up the order status.');
