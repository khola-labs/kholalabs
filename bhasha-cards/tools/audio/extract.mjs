import { LANGS, TEMPLATES, templateCards } from '../../js/data.js';
const out = {};
let total = 0, chars = 0;
for (const l of Object.keys(LANGS)) {
  const seen = new Map();
  for (const t of TEMPLATES) for (const c of templateCards(l, t.key)) {
    const w = c.word.trim(); if (!w) continue;
    if (!seen.has(w)) seen.set(w, { word: w, translit: c.translit, meaning: c.meaning, decks: [] });
    seen.get(w).decks.push(t.key);
  }
  out[l] = [...seen.values()];
  total += out[l].length; chars += out[l].reduce((n, x) => n + [...x.word].length, 0);
  console.log(l, out[l].length, 'words', out[l].reduce((n, x) => n + [...x.word].length, 0), 'chars');
}
console.log('TOTAL', total, 'words', chars, 'chars');
process.stdout.write('');
import { writeFileSync } from 'fs';
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
