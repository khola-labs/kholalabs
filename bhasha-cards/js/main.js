import { LANGS, TEMPLATES, templateCards, artFor } from './data.js';
import { loadDecks, saveDecks, uid, putPhoto, delPhoto, photoURL, processImage } from './store.js';
import { can, isPro, activate, deactivate, revalidate, PRICE, CHECKOUT_URL, FREE_LIMITS } from './entitlements.js';
import { prime as primeAudio, prefetch as prefetchAudio, hasClip, say } from './audio.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
let decks = loadDecks();
let lang = localStorage.getItem('bc.lang') || 'hi';

const persist = () => { try { saveDecks(decks); } catch (e) { toast('Storage full: remove some photos'); } };
const deckById = (id) => decks.find((d) => d.id === id);
const photoCount = () => decks.reduce((n, d) => n + d.cards.filter((c) => c.photoId).length, 0);
const customCount = () => decks.filter((d) => d.kind === 'custom').length;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- gate + paywall ---------- */
function gate(feature, ctx) {
  const r = can(feature, ctx);
  if (!r.ok) openPaywall(r.reason);
  return r.ok;
}
function openPaywall(reason = '') {
  const d = $('#paywall');
  const pro = isPro();
  d.innerHTML = `
    <form method="dialog" class="sheet-body">
      <button class="x" value="close" aria-label="Close">✕</button>
      <h2>${pro ? '✨ You have Pro' : '✨ Bhasha Cards Pro'}</h2>
      ${reason && !pro ? `<p class="reason">${esc(reason)}</p>` : ''}
      <ul class="ticks">
        <li>Every deck: Family, Animals, Food, and new packs as they're added</li>
        <li>Unlimited decks, cards and family photos</li>
        <li>No watermark on prints</li>
        <li>A4 9-up, US Letter and 6×4 photo-paper layouts</li>
      </ul>
      ${pro ? `<p class="reason">Using Pro on another phone or computer? Open this link there (up to 5 devices):</p>
      <div class="row"><input id="pwLink" readonly value="${esc(restoreLink())}"><button type="button" class="btn" id="pwCopy">Copy</button></div>
      <button type="button" class="btn ghost" id="pwOff">Deactivate on this device</button>` : `
      <div class="price"><b>${PRICE.usd}</b> <span>or ${PRICE.inr} in India</span><small>${PRICE.note}</small></div>
      <button type="button" class="btn primary" id="pwBuy">Unlock Pro</button>
      <details class="lic"><summary>Already bought? Enter license key</summary>
        <div class="row"><input id="pwKey" placeholder="XXXX-XXXX-XXXX" autocomplete="off"><button type="button" class="btn" id="pwAct">Activate</button></div>
      </details>`}
    </form>`;
  d.showModal();
  $('#pwBuy', d)?.addEventListener('click', () => {
    if (CHECKOUT_URL) location.href = CHECKOUT_URL;
    else toast('Pro opens soon. Email kholalabs.studio@gmail.com for the founding price.');
  });
  $('#pwAct', d)?.addEventListener('click', async () => {
    const r = await activate($('#pwKey', d).value);
    if (r.ok) { d.close(); toast('Pro unlocked. Thank you! 🎉'); refreshPro(); route(); } else toast(r.reason);
  });
  $('#pwOff', d)?.addEventListener('click', async () => { await deactivate(); d.close(); refreshPro(); route(); });
  $('#pwCopy', d)?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#pwLink', d).value); toast('Link copied. Send it to yourself on WhatsApp or email.'); }
    catch { $('#pwLink', d).select(); toast('Select the link and copy it'); }
  });
}
function restoreLink() {
  let k = ''; try { k = JSON.parse(localStorage.getItem('bc.license') || 'null')?.key || ''; } catch {}
  return k ? `${location.origin}${location.pathname}?license_key=${encodeURIComponent(k)}` : '';
}
function refreshPro() {
  const b = $('#proBtn'); b.textContent = isPro() ? '✨ Pro' : '✨ Go Pro'; b.classList.toggle('is-pro', isPro());
}
$('#proBtn').addEventListener('click', () => openPaywall());

/* ---------- card rendering ---------- */
// shrink long words (e.g. Tamil வாழைப்பழம்) so they stay on one line
const wordSize = (w = '') => Math.min(17, +(120 / Math.max([...w].length, 1)).toFixed(1));
async function cardHTML(c, l, opts = {}) {
  const { translit = true, english = true } = opts;
  const url = await photoURL(c.photoId);
  const art = !url && artFor(c.emoji);
  const pic = url ? `<img src="${url}" alt="">` : art ? `<img src="${art}" alt="" decoding="async">` : `<span class="emoji">${esc(c.emoji || '❔')}</span>`;
  return `<div class="card" lang="${l}">
    <div class="pic${art ? ' art' : ''}">${pic}</div>
    <div class="txt">
      <div class="word" style="font-family:${LANGS[l].font},'Nunito',sans-serif;font-size:${wordSize(c.word)}cqw">${esc(c.word) || '&nbsp;'}</div>
      ${translit && c.translit ? `<div class="tr">${esc(c.translit)}</div>` : ''}
      ${english && c.meaning ? `<div class="en">${esc(c.meaning)}</div>` : ''}
    </div></div>`;
}

/* ---------- views ---------- */
async function home() {
  const mine = decks.slice().sort((a, b) => b.updated - a.updated);
  view.innerHTML = `
    <section class="hero-mini">
      <h1>Teach them the words <span>you</span> grew up with.</h1>
      <p>Pick your language, start a deck and add photos of your own family.</p>
    </section>
    <section>
      <h3 class="label">Language</h3>
      <div class="chips" id="langs">${Object.entries(LANGS).map(([k, v]) =>
        `<button class="chip ${k === lang ? 'on' : ''}" data-l="${k}"><b style="font-family:${v.font}">${v.native}</b><small>${v.name}</small></button>`).join('')}</div>
    </section>
    <section>
      <h3 class="label">Start a deck</h3>
      <div class="tpl-grid">
        ${TEMPLATES.map((t) => `<button class="tpl" data-t="${t.key}">
          <span class="tpl-emoji">${artFor(t.emoji) ? `<img src="${artFor(t.emoji)}" alt="">` : t.emoji}</span><b>${t.title}</b><small>${t.blurb}</small>
          ${t.pro && !isPro() ? '<span class="lock">PRO</span>' : ''}</button>`).join('')}
        <button class="tpl blank" data-t="blank"><span class="tpl-emoji">✏️</span><b>Blank deck</b><small>Your own words</small></button>
      </div>
    </section>
    <section>
      <h3 class="label">Your decks</h3>
      ${mine.length ? `<div class="deck-list">${mine.map((d) => `
        <div class="deck-row">
          <a href="#/deck/${d.id}" class="deck-main">
            <span class="deck-ico">${artFor(d.cards[0]?.emoji) ? `<img src="${artFor(d.cards[0].emoji)}" alt="">` : esc(d.cards[0]?.emoji || '🗂️')}</span>
            <span><b>${esc(d.title)}</b><small>${LANGS[d.lang].name} · ${d.cards.length} cards</small></span>
          </a>
          <a class="icon-btn" href="#/practice/${d.id}" aria-label="Practise">▶</a>
          <a class="icon-btn" href="#/print/${d.id}" aria-label="Print">🖨</a>
        </div>`).join('')}</div>` : `<p class="empty">No decks yet. Try <b>My Family</b> above.</p>`}
    </section>`;
  view.querySelectorAll('[data-l]').forEach((b) => b.onclick = () => { lang = b.dataset.l; localStorage.setItem('bc.lang', lang); home(); });
  view.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => createDeck(b.dataset.t));
}

function createDeck(key) {
  let deck;
  if (key === 'blank') {
    if (!gate('newDeck', { customCount: customCount() })) return;
    deck = { id: uid(), kind: 'custom', lang, title: 'My words', cards: [{ id: uid(), word: '', translit: '', meaning: '', emoji: '⭐' }] };
  } else {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!gate('template', t)) return;
    deck = { id: uid(), kind: 'template', tpl: key, lang, title: `${t.title} · ${LANGS[lang].name}`,
      cards: templateCards(lang, key).map((c) => ({ id: uid(), ...c })) };
  }
  deck.updated = Date.now();
  decks.push(deck); persist();
  location.hash = `#/deck/${deck.id}`;
}

async function deckView(id) {
  const d = deckById(id); if (!d) return (location.hash = '#/');
  const cards = await Promise.all(d.cards.map((c) => cardHTML(c, d.lang)));
  view.innerHTML = `
    <div class="bar"><a href="#/" class="back">‹ Decks</a>
      <input class="title-in" id="title" value="${esc(d.title)}" aria-label="Deck title"></div>
    ${d.tpl === 'family' ? `<p class="hint">📷 Tap a card to add a photo of the real person. Kids learn faster when they see <b>their</b> Nani.</p>` : ''}
    <div class="card-grid">${cards.map((h, i) => `<button class="card-btn" data-i="${i}">${h}</button>`).join('')}
      <button class="add-card" id="add">＋<small>Add card</small></button></div>
    <div class="actions">
      <a class="btn primary" href="#/practice/${d.id}">▶ Practise</a>
      <a class="btn" href="#/print/${d.id}">🖨 Print</a>
    </div>
    <button class="link danger" id="del">Delete deck</button>`;
  $('#title').onchange = (e) => { d.title = e.target.value.trim() || 'Untitled'; d.updated = Date.now(); persist(); };
  view.querySelectorAll('.card-btn').forEach((b) => b.onclick = () => editCard(d, +b.dataset.i));
  $('#add').onclick = () => {
    if (!gate('addCard', { cardCount: d.cards.length })) return;
    d.cards.push({ id: uid(), word: '', translit: '', meaning: '', emoji: '⭐' }); persist(); editCard(d, d.cards.length - 1);
  };
  $('#del').onclick = async () => {
    if (!confirm('Delete this deck?')) return;
    for (const c of d.cards) if (c.photoId) await delPhoto(c.photoId);
    decks = decks.filter((x) => x !== d); persist(); location.hash = '#/';
  };
}

function editCard(d, i) {
  const c = d.cards[i]; const s = $('#sheet');
  const L = LANGS[d.lang];
  s.innerHTML = `
    <form method="dialog" class="sheet-body">
      <button class="x" value="close" aria-label="Close">✕</button>
      <h2>Edit card</h2>
      <div class="photo-row">
        <div class="mini" id="mini"></div>
        <div class="photo-btns">
          <label class="btn">📷 ${c.photoId ? 'Replace' : 'Add'} photo<input type="file" accept="image/*" id="file" hidden></label>
          ${c.photoId ? '<button type="button" class="btn ghost" id="rmPhoto">Remove photo</button>' : ''}
          <label class="emoji-in">or emoji <input id="emoji" value="${esc(c.emoji || '')}" maxlength="8"></label>
        </div>
      </div>
      <label>Word in ${L.name}<div class="row word-row"><input id="word" value="${esc(c.word)}" lang="${d.lang}" style="font-family:${L.font};font-size:1.4rem" placeholder="${L.native}">
      <button type="button" class="btn" id="hear" aria-label="Hear the word">🔊</button></div>
      <small class="voice-note" id="voiceNote"></small></label>
      <label>How to say it (Latin letters)<input id="translit" value="${esc(c.translit)}" placeholder="e.g. naani"></label>
      <label>Meaning in English<input id="meaning" value="${esc(c.meaning)}" placeholder="e.g. Grandmother"></label>
      <div class="row"><button type="button" class="btn primary" id="save">Save</button>
        <button type="button" class="btn ghost danger" id="rm">Delete card</button></div>
    </form>`;
  s.showModal();
  const mini = async () => { $('#mini', s).innerHTML = await cardHTML({ ...c, word: $('#word', s).value, translit: $('#translit', s).value, meaning: $('#meaning', s).value, emoji: $('#emoji', s).value }, d.lang); };
  const voiceNote = () => { const w = $('#word', s).value.trim(); $('#voiceNote', s).textContent = !w ? '' : hasClip(d.lang, w) ? '🎙 Native-voice recording available' : 'Your own word: read by this phone’s voice'; };
  mini(); voiceNote(); primeAudio(d.lang).then(voiceNote);
  ['word', 'translit', 'meaning', 'emoji'].forEach((k) => $('#' + k, s).addEventListener('input', mini));
  $('#word', s).addEventListener('input', voiceNote);
  $('#hear', s).onclick = () => sayCard(d.lang, { word: $('#word', s).value.trim(), translit: $('#translit', s).value.trim() });
  $('#file', s).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!c.photoId && !gate('addPhoto', { photoCount: photoCount() })) return;
    const blob = await processImage(f);
    if (c.photoId) await delPhoto(c.photoId);
    c.photoId = uid(); await putPhoto(c.photoId, blob); persist(); mini();
    toast('Photo added');
  };
  $('#rmPhoto', s)?.addEventListener('click', async () => { await delPhoto(c.photoId); delete c.photoId; persist(); mini(); });
  $('#save', s).onclick = () => {
    Object.assign(c, { word: $('#word', s).value.trim(), translit: $('#translit', s).value.trim(), meaning: $('#meaning', s).value.trim(), emoji: $('#emoji', s).value.trim() });
    d.updated = Date.now(); persist(); s.close();
  };
  $('#rm', s).onclick = async () => {
    if (c.photoId) await delPhoto(c.photoId);
    d.cards.splice(i, 1); persist(); s.close();
  };
  s.onclose = () => deckView(d.id);
}

/** Plays a card's word (recorded clip, else device voice) and explains any fallback once. */
async function sayCard(lang, c) {
  if (!c.word) return toast('Type a word first');
  const r = await say(lang, c);
  if (r.source === 'none') toast(r.note || 'Could not play audio on this device');
  else if (r.source === 'tts' && r.note && !sayCard.warned) { sayCard.warned = true; toast(r.note); }
}

async function practice(id) {
  const d = deckById(id); if (!d || !d.cards.length) return (location.hash = '#/');
  let i = 0, flipped = false;
  await primeAudio(d.lang);                     // recorded pronunciations for built-in words
  const render = async () => {
    const c = d.cards[i];
    const recorded = hasClip(d.lang, c.word);
    view.innerHTML = `
      <div class="bar"><a href="#/deck/${d.id}" class="back">‹ ${esc(d.title)}</a><span class="count">${i + 1} / ${d.cards.length}</span></div>
      <div class="practice ${flipped ? 'flipped' : ''}" id="pc" role="button" tabindex="0" aria-label="${flipped ? 'Card revealed. Tap to hide' : 'Tap to reveal the meaning'}">${await cardHTML(c, d.lang, { translit: flipped, english: flipped })}
        <p class="tap">${flipped ? (recorded ? '<span class="voice-tag">🎙 Native-voice recording</span>' : '') : 'Tap to reveal'}</p></div>
      <div class="actions three">
        <button class="btn" id="prev" ${i === 0 ? 'disabled' : ''} aria-label="Previous card">‹ Prev</button>
        <button class="btn primary" id="say" aria-label="Say the word">🔊 Say it</button>
        <button class="btn" id="next" aria-label="${i === d.cards.length - 1 ? 'Finish' : 'Next card'}">${i === d.cards.length - 1 ? 'Done ✓' : 'Next ›'}</button>
      </div>`;
    prefetchAudio(d.lang, c.word);
    if (d.cards[i + 1]) prefetchAudio(d.lang, d.cards[i + 1].word);
    const flip = () => { flipped = !flipped; render(); };
    $('#pc').onclick = flip;
    $('#pc').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
    $('#prev').onclick = () => { i--; flipped = false; render(); };
    $('#next').onclick = () => { if (i === d.cards.length - 1) { toast('Shabaash! 🎉 Deck complete'); location.hash = `#/deck/${d.id}`; } else { i++; flipped = false; render(); } };
    $('#say').onclick = () => sayCard(d.lang, c);
  };
  view.onkeydown = (e) => {
    if (e.target.closest('input,textarea')) return;
    if (e.key === 'ArrowRight') $('#next')?.click(); else if (e.key === 'ArrowLeft') { const b = $('#prev'); if (b && !b.disabled) b.click(); }
  };
  let x0 = null;
  view.ontouchstart = (e) => (x0 = e.touches[0].clientX);
  view.ontouchend = (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 60) { const b = $(dx < 0 ? '#next' : '#prev'); if (b && !b.disabled) b.click(); } };
  render();
}

const LAYOUTS = {
  'a4-4':   { name: 'A4 · 4 per page', page: '210mm 297mm', cols: 2, rows: 2 },
  'a4-9':   { name: 'A4 · 9 per page', page: '210mm 297mm', cols: 3, rows: 3 },
  'let-4':  { name: 'US Letter · 4 per page', page: '8.5in 11in', cols: 2, rows: 2 },
  'photo6': { name: '6×4" photo paper · 2 per sheet', page: '6in 4in', cols: 2, rows: 1 },
};

async function printView(id) {
  const d = deckById(id); if (!d) return (location.hash = '#/');
  const o = JSON.parse(localStorage.getItem('bc.print') || '{"layout":"a4-4","translit":true,"english":true}');
  if (!can('layout', o).ok) o.layout = 'a4-4';
  view.innerHTML = `
    <div class="bar"><a href="#/deck/${d.id}" class="back">‹ ${esc(d.title)}</a></div>
    <h2 class="h2">Print cut-sheets</h2>
    <div class="print-opts">
      <label>Layout<select id="layout">${Object.entries(LAYOUTS).map(([k, v]) =>
        `<option value="${k}" ${k === o.layout ? 'selected' : ''}>${v.name}${k !== 'a4-4' && !isPro() ? ' (Pro)' : ''}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="translit" ${o.translit ? 'checked' : ''}> Show pronunciation</label>
      <label class="check"><input type="checkbox" id="english" ${o.english ? 'checked' : ''}> Show English</label>
    </div>
    <div class="preview" id="preview"></div>
    <div class="actions"><button class="btn primary" id="go">🖨 Print / Save as PDF</button></div>
    ${isPro() ? '' : `<p class="hint small">Free prints carry a small “Made with Bhasha Cards” footer. <a href="#" id="upg">Remove it with Pro</a>.</p>`}`;
  const build = async () => {
    const L = LAYOUTS[o.layout], per = L.cols * L.rows;
    const cards = await Promise.all(d.cards.map((c) => cardHTML(c, d.lang, o)));
    let pages = '';
    for (let p = 0; p < cards.length; p += per) {
      pages += `<div class="page" style="--cols:${L.cols};--rows:${L.rows}">${cards.slice(p, p + per).map((h) => `<div class="cell">${h}</div>`).join('')}
        ${isPro() ? '' : '<div class="wm">Made with Bhasha Cards · by Khola Labs</div>'}</div>`;
    }
    const [pw, ph] = L.page.split(' ');
    const html = `<style>@page{size:${L.page};margin:0} .page{width:${pw};height:${ph}}</style>${pages}`;
    $('#print-area').innerHTML = html;
    $('#preview').innerHTML = html;
    fitPreview();
  };
  $('#layout').onchange = (e) => {
    if (!gate('layout', { layout: e.target.value })) { e.target.value = o.layout; return; }
    o.layout = e.target.value; save(); build();
  };
  ['translit', 'english'].forEach((k) => $('#' + k).onchange = (e) => { o[k] = e.target.checked; save(); build(); });
  const save = () => localStorage.setItem('bc.print', JSON.stringify(o));
  $('#go').onclick = () => window.print();
  $('#upg')?.addEventListener('click', (e) => { e.preventDefault(); openPaywall('Remove the watermark with Pro.'); });
  await build();
}
function fitPreview() {
  const pv = $('#preview'); if (!pv) return;
  pv.querySelectorAll('.page').forEach((pg) => {
    const s = Math.min(1, (pv.clientWidth - 2) / pg.offsetWidth);
    pg.style.transform = `scale(${s})`; pg.style.marginBottom = `${pg.offsetHeight * (s - 1) + 12}px`;
  });
}
addEventListener('resize', fitPreview);

/* ---------- router ---------- */
async function route() {
  const [, v, id] = (location.hash || '#/').split('/');
  view.ontouchstart = view.ontouchend = null;
  if (v !== 'print') $('#print-area').innerHTML = '';
  if (v === 'deck') await deckView(id);
  else if (v === 'practice') await practice(id);
  else if (v === 'print') await printView(id);
  else await home();
  scrollTo(0, 0);
}
addEventListener('hashchange', route);

/* ---------- auto-activate after checkout ----------
   Dodo sends the buyer back to app.html?payment_id=…&status=succeeded&license_key=KEY (several keys are
   comma-separated). The same ?license_key=KEY link also works as a "restore Pro" link on another device. */
async function activateFromURL() {
  const q = new URLSearchParams(location.search);
  const key = (q.get('license_key') || '').split(',')[0].trim();
  const status = q.get('status');
  if (!key && !status) return;
  history.replaceState(null, '', location.pathname + location.hash);   // keep the key out of history/bookmarks
  if (status && status !== 'succeeded' && !key) { toast('Payment not completed. You have not been charged for Pro.'); return; }
  if (!key || isPro()) return;
  toast('Unlocking Pro…');
  const r = await activate(key);
  if (r.ok) { refreshPro(); route(); toast('Pro unlocked. Thank you! 🎉'); }
  else { openPaywall(r.reason); const i = $('#pwKey'); if (i) { i.value = key; i.closest('details').open = true; } }
}

refreshPro();
route();
activateFromURL().finally(() => revalidate().then(() => { refreshPro(); }));

// expose for tests / debugging
window.__bc = { FREE_LIMITS, decks: () => decks };
