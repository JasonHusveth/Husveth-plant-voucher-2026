// Calibrate the unlisted-species penalty for provisional profiles: plots simulated from classes WITH DNR tables
// should rarely be won by a provisional class (false positives), while plots simulated from a provisional profile
// should usually find it.
import fs from 'fs';
import { rankClasses, candidatesFor, PARAMS } from '../engine.js';
const D = JSON.parse(fs.readFileSync(new URL('../data/npc-data.json', import.meta.url)));
const byKey = new Map(); for (const s of D.species) if (!byKey.has(s.k) || s.r === 'species') byKey.set(s.k, s.n);
const nameFor = key => { const k = key.split('|')[0]; return k.startsWith('g:') || k.startsWith('b:') ? null : byKey.get(k); };
let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const sim = code => {
  const p = D.profiles[code], sp = [];
  for (const [k, [f, c]] of Object.entries(p.g)) if (rnd() < f / 100 * 0.75) { const n = nameFor(k); if (n) sp.push({ n, layer: 'G', cover: c || 1 }); }
  for (const [k, L] of Object.entries(p.t)) for (const [l, [f, c]] of Object.entries(L)) if (rnd() < f / 100 * 0.75) { const n = nameFor(k); if (n) sp.push({ n, layer: l === 'U' ? 'S' : l, cover: c || 1 }); }
  // background noise: a few species from the whole flora, as real plots have
  for (let i = 0; i < 3; i++) sp.push({ n: D.species[Math.floor(rnd() * D.species.length)].n, layer: 'G', cover: 1 });
  return { species: sp };
};
for (const eps of [0.03, 0.06, 0.1, 0.15, 0.2]) {
  const P = { ...PARAMS, epsProv: eps }; let fp = 0, nReal = 0, hit = 0, nProv = 0, top3 = 0;
  for (const sec of D.sections) {
    const c = candidatesFor(sec.code, D);
    for (const code of c) for (let i = 0; i < 12; i++) {
      const r = rankClasses(sim(code), D, c, P);
      if (D.profiles[code].prov) { nProv++; if (r[0].code === code) hit++; if (r.slice(0, 3).some(x => x.code === code)) top3++; }
      else { nReal++; if (r[0].prov) fp++; }
    }
  }
  console.log(`epsProv ${eps}: real-class plots won by a provisional class ${(100 * fp / nReal).toFixed(1)}% | provisional-class plots found top-1 ${(100 * hit / nProv).toFixed(0)}%, top-3 ${(100 * top3 / nProv).toFixed(0)}%`);
}
