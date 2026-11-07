// Paywall abstraction. Everything that is gated goes through can(). Swap activate() for a real
// license check (Lemon Squeezy / Dodo / Gumroad license-key API, or Play Billing via Capacitor) later.

export const PRICE = { usd: '$12', inr: '₹399', note: 'one-time · lifetime updates · up to 5 devices' };

// Dodo live product pdt_0NqCGP7Vz8oa2x6DsVojI ($12, ₹399 in India, license key, 5 activations). Deploy only after Dodo approves the business.
export const CHECKOUT_URL = 'https://checkout.dodopayments.com/buy/pdt_0NqCGP7Vz8oa2x6DsVojI?quantity=1&redirect_url=https%3A%2F%2Fkhola-labs.github.io%2Fkholalabs%2Fbhasha-cards%2Fapp.html';

export const FREE_LIMITS = { customDecks: 1, cardsPerDeck: 10, photos: 3 };

const KEY = 'bc.license';
const DEMO_KEY = 'BHASHA-PRO-DEMO'; // dev-only unlock: works on localhost only
const IS_DEV = ['localhost', '127.0.0.1'].includes(location.hostname);

export function isPro() {
  try { return !!JSON.parse(localStorage.getItem(KEY) || 'null')?.active; } catch { return false; }
}

/** Returns {ok:true} or {ok:false, reason}. ctx carries counts the check needs. */
export function can(feature, ctx = {}) {
  if (isPro()) return { ok: true };
  switch (feature) {
    case 'template':    return ctx.pro ? no('The “' + ctx.title + '” deck is part of Pro.') : { ok: true };
    case 'newDeck':     return ctx.customCount >= FREE_LIMITS.customDecks ? no(`Free plan includes ${FREE_LIMITS.customDecks} custom deck.`) : { ok: true };
    case 'addCard':     return ctx.cardCount >= FREE_LIMITS.cardsPerDeck ? no(`Free decks hold up to ${FREE_LIMITS.cardsPerDeck} cards.`) : { ok: true };
    case 'addPhoto':    return ctx.photoCount >= FREE_LIMITS.photos ? no(`Free plan includes ${FREE_LIMITS.photos} family photos.`) : { ok: true };
    case 'layout':      return ctx.layout !== 'a4-4' ? no('Letter, 9-up and 6×4 photo-paper layouts are Pro.') : { ok: true };
    case 'noWatermark': return no('Remove the watermark with Pro.');
    default:            return { ok: true };
  }
}
const no = (reason) => ({ ok: false, reason });

// Dodo Payments license keys: public endpoints, CORS-enabled, no API key needed.
const DODO = IS_DEV ? 'https://test.dodopayments.com' : 'https://live.dodopayments.com';
const post = (path, body) => fetch(DODO + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Activates a license key on this device. Returns {ok:true} or {ok:false, reason}. */
export async function activate(licenseKey) {
  const k = (licenseKey || '').trim();
  if (!k) return { ok: false, reason: 'Please enter your license key.' };
  if (IS_DEV && k.toUpperCase() === DEMO_KEY) {
    localStorage.setItem(KEY, JSON.stringify({ active: true, key: k, at: Date.now(), source: 'demo' }));
    return { ok: true };
  }
  try {
    const r = await post('/licenses/activate', { license_key: k, name: `Bhasha Cards · ${navigator.platform || 'device'}` });
    if (r.ok) {
      const j = await r.json();
      localStorage.setItem(KEY, JSON.stringify({ active: true, key: k, instance: j.id, at: Date.now(), source: 'dodo' }));
      return { ok: true };
    }
    const msg = { 403: 'This key is not active. If you were refunded, Pro is switched off.', 404: 'That key wasn’t recognised. Please check it and try again.', 422: 'This key is already in use on 5 devices. Deactivate one first, or email kholalabs.studio@gmail.com.' }[r.status];
    return { ok: false, reason: msg || 'Could not activate right now. Please try again.' };
  } catch { return { ok: false, reason: 'You seem to be offline. Connect to the internet to activate.' }; }
}

/** Re-checks a stored key at most once a week. Stays Pro when offline; only a definite "invalid" turns it off. */
export async function revalidate() {
  let lic; try { lic = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return; }
  if (!lic?.active || lic.source !== 'dodo' || Date.now() - (lic.checked || lic.at) < 7 * 864e5) return;
  try {
    const r = await post('/licenses/validate', { license_key: lic.key, license_key_instance_id: lic.instance });
    if (!r.ok) return;
    const { valid } = await r.json();
    if (valid) localStorage.setItem(KEY, JSON.stringify({ ...lic, checked: Date.now() }));
    else localStorage.removeItem(KEY);
  } catch { /* offline: keep Pro */ }
}

export async function deactivate() {
  let lic; try { lic = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  localStorage.removeItem(KEY);
  if (lic?.source === 'dodo' && lic.instance) {
    try { await post('/licenses/deactivate', { license_key: lic.key, license_key_instance_id: lic.instance }); } catch {}
  }
}
