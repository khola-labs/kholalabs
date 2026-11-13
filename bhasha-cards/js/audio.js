// Pronunciation audio. Built-in words have recorded clips (audio/<lang>/<slug>.mp3, generated offline by
// tools/audio/make_audio.py with ElevenLabs; manifest audio/<lang>.json maps word -> slug). Anything else,
// e.g. a parent's own custom card, falls back to the device's speechSynthesis voice. No keys, no server.
import { LANGS } from './data.js';

const BASE = 'audio/';
const manifests = {};                 // lang -> {word: slug} once loaded
const loading = {};                   // lang -> Promise

/** Load (once) the word -> clip manifest for a language. Resolves to {} when offline and uncached. */
export function prime(lang) {
  if (manifests[lang]) return Promise.resolve(manifests[lang]);
  loading[lang] ||= fetch(`${BASE}${lang}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
    .then((m) => (manifests[lang] = m));
  return loading[lang];
}
/** Synchronous lookup (after prime). Null when there is no recorded clip for this word. */
export function clipURL(lang, word) {
  const s = manifests[lang]?.[(word || '').trim()];
  return s ? `${BASE}${lang}/${s}.mp3` : null;
}
export const hasClip = (lang, word) => !!clipURL(lang, word);

/** Warm the HTTP/service-worker cache so "Say it" is instant on the next card. */
export function prefetch(lang, word) {
  const u = clipURL(lang, word);
  if (u && !prefetch.done.has(u)) { prefetch.done.add(u); fetch(u).catch(() => {}); }
}
prefetch.done = new Set();

/* ---------- one shared <audio> element (iOS lets a media element play later if it was started in a gesture) ---------- */
let player;
function getPlayer() {
  if (!player) { player = new Audio(); player.preload = 'auto'; player.setAttribute('playsinline', ''); }
  return player;
}
// iOS Safari: unlock audio + speech on the first touch anywhere, so later taps never hit the autoplay wall.
let unlocked = false;
function unlock() {
  if (unlocked) return; unlocked = true;
  try {
    const p = getPlayer();
    if (!p.src) p.src = silentWav();
    p.play().then(() => { p.pause(); p.currentTime = 0; }).catch(() => {});
    if ('speechSynthesis' in window) { speechSynthesis.resume(); }
  } catch {}
}
// 50 ms of silence as a WAV data URI (built here so there is no binary blob to maintain)
function silentWav() {
  const n = 400, b = new Uint8Array(44 + n), v = new DataView(b.buffer), s = (o, t) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, 'data'); v.setUint32(40, n, true);
  b.fill(128, 44);
  return 'data:audio/wav;base64,' + btoa(String.fromCharCode(...b));
}
addEventListener('pointerdown', unlock, { once: true, capture: true });
addEventListener('keydown', unlock, { once: true, capture: true });

/* ---------- speechSynthesis fallback ---------- */
const loadVoices = () => new Promise((res) => {
  const vs = speechSynthesis.getVoices(); if (vs.length) return res(vs);
  speechSynthesis.addEventListener('voiceschanged', () => res(speechSynthesis.getVoices()), { once: true });
  setTimeout(() => res(speechSynthesis.getVoices()), 1500);
});
async function bestVoice(lang) {
  const tag = LANGS[lang].tts.slice(0, 2);
  return (await loadVoices()).filter((v) => v.lang.replace('_', '-').startsWith(tag))
    .sort((a, b) => /google/i.test(b.name) - /google/i.test(a.name))[0];
}
/** Speak with the device voice. Resolves to {ok, note} where note explains a fallback to transliteration. */
export async function synth(lang, card) {
  if (!('speechSynthesis' in window)) return { ok: false, note: 'Speech is not supported on this device' };
  const u = new SpeechSynthesisUtterance(card.word); u.lang = LANGS[lang].tts; u.rate = 0.9;
  const v = await bestVoice(lang); let note = '';
  if (v) u.voice = v;
  else if (card.translit) { u.text = card.translit; u.lang = 'en-IN'; note = `No ${LANGS[lang].name} voice on this phone, so reading “${card.translit}”`; }
  else note = `No ${LANGS[lang].name} voice on this phone`;
  u.onerror = (e) => e.error !== 'interrupted' && e.error !== 'canceled' && console.warn('tts', e.error);
  speechSynthesis.cancel(); speechSynthesis.resume();         // resume() unsticks Chrome's queue after idle
  setTimeout(() => speechSynthesis.speak(u), 50);
  return { ok: true, note };
}

/* ---------- public: say a card ---------- */
let seq = 0;
/**
 * Plays the recorded clip when one exists, otherwise the device voice.
 * Call from a user gesture. Resolves to {source:'clip'|'tts', note}.
 */
export async function say(lang, card) {
  const my = ++seq;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  const url = clipURL(lang, card.word);
  if (url) {
    const p = getPlayer();
    const played = await new Promise((res) => {
      let done = false; const finish = (ok) => { if (!done) { done = true; res(ok); } };
      p.onerror = () => finish(false);
      p.onplaying = () => finish(true);
      if (!p.paused) p.pause();
      p.src = url; p.currentTime = 0;
      p.play().catch(() => finish(false));
      setTimeout(() => finish(false), 4000);
    });
    if (my !== seq) return { source: 'none' };
    if (played) return { source: 'clip', note: '' };
  }
  const r = await synth(lang, card);
  return { source: r.ok ? 'tts' : 'none', note: r.note };
}
