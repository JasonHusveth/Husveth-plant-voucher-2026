import fs from 'fs';
import { runClassKey, candidatesFor, keysForClass } from '../engine.js';
const data = JSON.parse(fs.readFileSync(new URL('../data/npc-data.json', import.meta.url)));
const byKey = new Map(); for (const s of data.species) if (!byKey.has(s.k) || s.r === 'species') byKey.set(s.k, s.n);
const byGenus = new Map(); for (const s of data.species) { const g = s.k.split(' ')[0]; if (!byGenus.has(g)) byGenus.set(g, s.n); }
const nameFor = key => { const k = key.split('|')[0]; return k.startsWith('g:') ? byGenus.get(k.slice(2)) : byKey.get(k); };
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const simPlot = code => {
  const p = data.profiles[code], sp = [];
  for (const [key, [f]] of Object.entries(p.g)) if (rnd() < f / 100 * 0.8) { const n = nameFor(key); if (n) sp.push({ n, layer: 'G', cover: p.g[key][1] || 1 }); }
  for (const [key, lays] of Object.entries(p.t)) for (const [L, [f]] of Object.entries(lays)) if (rnd() < f / 100 * 0.8) { const n = nameFor(key); if (n) sp.push({ n, layer: L === 'U' ? 'S' : L, cover: lays[L][1] || 1 }); }
  return { species: sp };
};
// class -> class key id via the system key panel that lists it
function keyFor(sec, code) {
  const ks = keysForClass(sec, code, data); if (ks.length) return ks[0];
  for (const sk of data.systemKeys[sec] || []) for (const col of sk.cols) if (col.classes.some(c => c.startsWith(code)) && col.classkey) return col.classkey;
  return null;
}
const tally = { right: 0, wrong: 0, choose: 0, nokey: 0, other: 0 }; const wrongs = {}, missing = new Set();
for (const sec of data.sections) {
  for (const code of candidatesFor(sec.code, data)) {
    const kid = keyFor(sec.code, code);
    const key = kid && data.classKeys[sec.code]?.[kid];
    if (!key) { tally.nokey += 20; missing.add(`${sec.code}:${code}->${kid}`); continue; }
    for (let i = 0; i < 20; i++) {
      const r = runClassKey(simPlot(code), key);
      if (r.result) { if (r.result.startsWith(code)) tally.right++; else { tally.wrong++; wrongs[`${sec.code} ${code}>${r.result}`] = (wrongs[`${sec.code} ${code}>${r.result}`] || 0) + 1; } }
      else if (r.stop === 'choose') tally.choose++; else { tally.other++; wrongs[`${sec.code} ${code} stop:${r.stop}:${r.target || r.at}`] = (wrongs[`${sec.code} ${code} stop:${r.stop}:${r.target || r.at}`] || 0) + 1; }
    }
  }
}
console.log(tally);
console.log('no class key found:', [...missing].join(', '));
console.log('wrong/other:', Object.entries(wrongs).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${v}`).join('\n'));
