// node app/test/simulate.mjs [eps absWeight temperature]
import fs from 'fs';
import { rankClasses, candidatesFor, PARAMS, binom } from '../engine.js';
const data = JSON.parse(fs.readFileSync(new URL('../data/npc-data.json', import.meta.url)));
const byKey = new Map(); for (const s of data.species) if (!byKey.has(s.k) || s.r === 'species') byKey.set(s.k, s.n);
const byGenus = new Map(); for (const s of data.species) { const g = s.k.split(' ')[0]; if (!byGenus.has(g)) byGenus.set(g, s.n); }
const nameFor = key => { const k = key.split('|')[0]; return k.startsWith('g:') ? byGenus.get(k.slice(2)) : k.startsWith('b:') ? k.slice(2) : byKey.get(k); };

let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function simPlot(code, detect = 0.7) {
  const p = data.profiles[code], sp = [];
  for (const [key, [f]] of Object.entries(p.g)) if (rnd() < f / 100 && rnd() < detect) { const n = nameFor(key); if (n) sp.push({ n, layer: 'G' }); }
  for (const [key, lays] of Object.entries(p.t)) for (const [L, [f]] of Object.entries(lays)) {
    if (rnd() < f / 100 && rnd() < detect) { const n = nameFor(key); if (n) sp.push({ n, layer: L === 'U' ? (rnd() < .5 ? 'S' : 'H') : L }); }
  }
  // a couple of incidental species not in the table
  for (let i = 0; i < 2; i++) { const s = data.species[Math.floor(rnd() * data.species.length)]; if (s.ns === 'N') sp.push({ n: s.n, layer: 'G' }); }
  return { species: sp };
}
const [eps, aw, T] = process.argv.slice(2).map(Number);
const params = { ...PARAMS, ...(eps ? { eps } : {}), ...(aw ? { absWeight: aw } : {}), ...(T ? { temperature: T } : {}) };
let n = 0, top1 = 0, top3 = 0; const bins = Array.from({ length: 10 }, () => [0, 0]); const conf = {};
for (const sec of data.sections) {
  const cands = candidatesFor(sec.code, data);
  for (const code of cands) for (let i = 0; i < 25; i++) {
    const plot = simPlot(code); const r = rankClasses(plot, data, cands, params);
    n++; if (r[0].code === code) top1++; if (r.slice(0, 3).some(x => x.code === code)) top3++;
    const b = Math.min(9, Math.floor(r[0].prob * 10)); bins[b][0]++; if (r[0].code === code) bins[b][1]++;
    if (r[0].code !== code) conf[code + '>' + r[0].code] = (conf[code + '>' + r[0].code] || 0) + 1;
  }
}
console.log(JSON.stringify(params), `plots ${n}  top1 ${(100 * top1 / n).toFixed(1)}%  top3 ${(100 * top3 / n).toFixed(1)}%`);
console.log('calibration (stated top prob -> actual):', bins.map((b, i) => b[0] ? `${i * 10}-${i * 10 + 10}%: ${(100 * b[1] / b[0]).toFixed(0)}% of ${b[0]}` : null).filter(Boolean).join(' | '));
console.log('top confusions:', Object.entries(conf).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', '));
