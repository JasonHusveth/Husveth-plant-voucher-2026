import fs from 'fs'; import { ecsLookup } from '../engine.js';
const E = JSON.parse(fs.readFileSync(new URL('../data/ecs.json', import.meta.url)));
for (const [n, la, lo] of [['Stillwater office', 45.0567, -92.8063], ['Itasca SP', 47.2394, -95.2069], ['Ely', 47.9032, -91.8671], ['Red Wing bluffs', 44.5625, -92.5338],
  ['Fergus Falls', 46.283, -96.0776], ['Big Bog', 48.21, -94.55], ['Pipestone', 44.0, -96.32], ['Duluth', 46.7867, -92.1005], ['Cedar Creek', 45.40, -93.20],
  ['Grand Marais', 47.75, -90.33], ['Lancaster LAP', 48.86, -96.80], ['Des Moines (IA)', 41.59, -93.62]]) {
  const t = Date.now(); const r = ecsLookup(la, lo, E);
  console.log(n.padEnd(18), r.outside ? 'OUTSIDE' : `${r.sec} | ${r.sub} | ${r.lta} (${r.ltaCode}) sub-edge ${r.edgeKm.toFixed(1)} lta-edge ${r.ltaEdgeKm.toFixed(1)} km${r.offMapKm ? ' offmap ' + r.offMapKm.toFixed(1) : ''}`, Date.now() - t, 'ms');
}
