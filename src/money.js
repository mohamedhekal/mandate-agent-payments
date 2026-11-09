// Money is always handled as integer cents internally. PayPal wants "12.34" strings.
export function toCents(value) {
  if (value === null || value === undefined || value === '') throw new Error('amount is required');
  const s = typeof value === 'number' ? String(value) : String(value).trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid amount: ${value}`);
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('amount too large');
  return cents;
}

export const fromCents = (c) => (c / 100).toFixed(2);

export function fmt(cents, currency = 'USD') {
  const sign = cents < 0 ? '-' : '';
  const v = fromCents(Math.abs(cents));
  return currency === 'USD' ? `${sign}$${v}` : `${sign}${currency} ${v}`;
}
