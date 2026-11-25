import fs from 'fs';
import { rankUnits } from '../engine.js';
const D = JSON.parse(fs.readFileSync(new URL('../data/npc-data.json', import.meta.url)));
const P = (section, sp, layerCover = {}) => ({ section, layerCover, species: sp.map(([n, layer, cover]) => ({ n, layer, cover })) });
const show = (label, cls, plot, parent) => {
  const units = D.types[cls].units.filter(u => parent ? u.parent === parent : u.lv === 'type');
  const r = rankUnits(plot, units, plot.section);
  console.log(`\n== ${label} (${cls}${parent ? ' / ' + parent : ''})`);
  for (const x of r) console.log(`  ${x.code} ${(x.prob * 100).toFixed(0)}%  ${x.ev.map(e => (e.v > 0 ? '+' : e.v < 0 ? '-' : '·') + e.t).join('; ')}`);
};
// Big Woods sugar maple forest in MIM with hackberry, puttyroot, nettle
show('Big Woods MIM', 'MHs39', P('MIM', [['Acer saccharum', 'C', 5], ['Tilia americana', 'C', 3], ['Celtis occidentalis', 'C', 2], ['Acer saccharum', 'S', 4], ['Sambucus racemosa', 'H', 2],
  ['Aplectrum hyemale', 'G', 1], ['Polygonatum biflorum', 'G', 1], ['Laportea canadensis', 'G', 4], ['Hydrophyllum virginianum', 'G', 2]]));
// PPL blue beech maple forest
show('PPL blue beech', 'MHs39', P('PPL', [['Acer saccharum', 'C', 5], ['Quercus rubra', 'C', 3], ['Carpinus caroliniana', 'S', 3], ['Staphylea trifolia', 'H', 2], ['Carex woodii', 'G', 2], ['Milium effusum', 'G', 1], ['Podophyllum peltatum', 'G', 2], ['Claytonia virginica', 'G', 2]]));
// Sedge meadow vs shrub swamp, then subtypes
const sm = P('MDL', [['Carex stricta', 'G', 5], ['Calamagrostis canadensis', 'G', 3], ['Salix bebbiana', 'H', 1]], { H: 1 });
show('Tussock sedge meadow', 'WMn82', sm); show('Tussock sedge meadow', 'WMn82', sm, 'WMn82b');
show('Willow-dogwood swamp', 'WMn82', P('MDL', [['Cornus sericea', 'H', 4], ['Salix discolor', 'H', 3], ['Calamagrostis canadensis', 'G', 3]], { H: 4 }));
// bog subtypes
const units = D.types.APn80.units; console.log('\nAPn80 units', units.map(u => u.code + ':' + u.lv + ':' + u.parent).join(' '));
show('Treed bog', 'APn80', P('MOP', [['Picea mariana', 'C', 5], ['Vaccinium vitis-idaea', 'G', 2], ['Monotropa uniflora', 'G', 1], ['Rhododendron groenlandicum', 'H', 3]]), 'APn80a');
show('Semi-treed bog', 'APn80', P('MOP', [['Picea mariana', 'C', 2], ['Larix laricina', 'C', 2], ['Carex pauciflora', 'G', 2], ['Sarracenia purpurea', 'G', 1], ['Eriophorum vaginatum', 'G', 3]]), 'APn80a');
