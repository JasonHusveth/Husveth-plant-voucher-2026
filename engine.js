// NPC scoring engine — shared by the field app (browser) and the test harness (node).
// Three independent lines of evidence for a plot:
//   1. likelihood ranking against each class's species frequency table (all classes with tables)
//   2. the DNR scored class key, run lead by lead from the plot's species
//   3. the DNR probability key (wooded classes, LMF and EBF sections only)
// plus floristic quality (mean C, FQI) from MNTaxa 2026 C values.

export const ENGINE_VERSION = '0.12.1';

// ---------- species keys ----------
export function binom(name) {
  const w = String(name).replace(/×/g, 'x').trim().split(/\s+/);
  if (w.length > 2 && w[1] === 'x') return `${w[0]} x${w[2]}`.toLowerCase();
  return w.slice(0, 2).join(' ').toLowerCase();
}
const genusKey = k => 'g:' + k.split(' ')[0];

// Plot layers: C canopy >10 m, S subcanopy 2-10 m, H shrub layer <2 m, G ground (forbs, graminoids, ferns, low shrubs)
// plot.species: [{n: MNTaxa name, layer: 'C'|'S'|'H'|'G', cover: 1-5}]
export function plotIndex(plot) {
  const any = new Set(), byLayer = { C: new Set(), S: new Set(), H: new Set(), G: new Set() }, cover = new Map();
  for (const s of plot.species || []) {
    if (!s.n) continue;
    const k = binom(s.n);
    for (const key of [k, genusKey(k), 'b:' + String(s.n).toLowerCase()]) {
      any.add(key); (byLayer[s.layer] || byLayer.G).add(key);
      cover.set(key, Math.max(cover.get(key) || 0, s.cover || 0));
    }
  }
  return { any, byLayer, cover };
}
// cover qualifier printed in a key ('>25% cover') -> minimum cover rank (1 <5%, 2 5-10, 3 10-25, 4 25-50, 5 >50)
function minRank(q) {
  const m = String(q || '').match(/(\d+)\s*%/); if (!m) return 0;
  const v = +m[1]; return v >= 50 ? 5 : v >= 25 ? 4 : v >= 10 ? 3 : v >= 5 ? 2 : 1;
}
// does a key species count for this plot? honours (C)/(U) layer codes and cover qualifiers
export function keySpeciesPresent(s, idx) {
  const lay = String(s.l || '').toUpperCase();
  const sets = lay === 'C' ? [idx.byLayer.C] : lay === 'U' ? [idx.byLayer.S, idx.byLayer.H, idx.byLayer.G] : [idx.any];
  const k = s.k.find(k => sets.some(set => set.has(k)));
  if (!k) return false;
  const need = minRank(s.q);
  return !need || (idx.cover.get(k) || 0) >= need;
}
const hasAny = (set, featureKey) => featureKey.split('|').some(k => set.has(k));

// tree-table layer -> plot layers that count as evidence
const TREE_LAYERS = { C: ['C'], S: ['S'], H: ['H'], U: ['S', 'H'] };

// ---------- 1. likelihood ranking ----------
// Bernoulli naive Bayes over each class's listed features, with background-relative scoring so that
// classes with short species lists are not favoured. Unlisted plot species get a small probability.
export const PARAMS = { eps: 0.03, epsProv: 0.03, absWeight: 0.5, temperature: 4, minFeatures: 1, coverW: 0.8 };
// coverW: canopy trees are also scored on cover: each cover-rank step between the plot and the class's typical canopy
// cover costs coverW (log units), so which conifer DOMINATES (black spruce vs tamarack vs cedar) counts, not just presence.
// epsProv: penalty for a plot species a provisional profile (class without a DNR frequency table) does not list.
// test/provisional.mjs: at 0.03 provisional classes win 0.2% of plots simulated from other classes and 98% of their own;
// softer values (0.06-0.2) let them win 1-28% of other classes' plots, so they get the same treatment as the rest.

export function classFeatures(profile) {
  const f = [];
  for (const [key, [freq]] of Object.entries(profile.g)) f.push({ key, p: freq / 100, layers: null });
  for (const [key, lays] of Object.entries(profile.t)) {
    for (const [lay, [freq, cv]] of Object.entries(lays)) f.push({ key, p: freq / 100, layers: TREE_LAYERS[lay] || ['S', 'H'], canopyCover: lay === 'C' ? cv : null });
  }
  return f;
}

export function rankClasses(plot, data, candidates, params = PARAMS, priors = null) {
  const idx = plotIndex(plot);
  const canopy = new Map();                                    // canopy cover rank by species key
  for (const s of plot.species || []) if (s.n && s.layer === 'C' && s.cover) { const k = binom(s.n); canopy.set(k, Math.max(canopy.get(k) || 0, s.cover)); }
  const plotKeys = [...new Set((plot.species || []).filter(s => s.n).map(s => binom(s.n)))];
  const out = [];
  for (const code of candidates) {
    const prof = data.profiles[code]; if (!prof) continue;
    const feats = classFeatures(prof);
    let ll = 0; const explained = new Set(); const hits = [], misses = [];
    for (const f of feats) {
      const present = f.layers ? f.layers.some(L => hasAny(idx.byLayer[L], f.key)) || (hasAny(idx.any, f.key) && !Object.keys(prof.g).length)
                               : hasAny(idx.any, f.key);
      const p = Math.min(Math.max(f.p, 0.01), 0.99);
      if (present) {
        ll += Math.log(p); f.key.split('|').forEach(k => explained.add(k.replace(/^g:/, ''))); if (p >= 0.5) hits.push(f);
        if (f.canopyCover && params.coverW) { const r = Math.max(...f.key.split('|').map(k => canopy.get(k) || 0)); if (r) ll -= params.coverW * Math.abs(r - f.canopyCover); }
      }
      else { ll += params.absWeight * Math.log(1 - p); if (p >= 0.6) misses.push(f); }
    }
    for (const k of plotKeys) {
      const g = k.split(' ')[0];
      if (!explained.has(k) && !explained.has(g)) ll += Math.log(prof.prov ? params.epsProv : params.eps);
    }
    out.push({ code, ll, hits, misses, nFeat: feats.length, prov: !!prof.prov, expert: prof.expert || null });
  }
  if (!out.length) return [];
  for (const o of out) { o.prior = priors?.[o.code] ?? 0; o.score = o.ll / params.temperature + o.prior; }
  const m = Math.max(...out.map(o => o.score));
  let z = 0; for (const o of out) { o.w = Math.exp(o.score - m); z += o.w; }
  for (const o of out) o.prob = o.w / z;
  return out.sort((a, b) => b.prob - a.prob);
}

// ---------- 2. scored class key ----------
// Evaluates couplets: sum of scores of the plot's species listed under lead x and x'; the lead whose rule
// holds is followed. Leads without a scored rule stop the run and ask the user to choose.
const OPS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '=': (a, b) => a === b };
export function runClassKey(plot, key, startLead = 'a', choices = {}) {
  const idx = plotIndex(plot);
  const byId = {}; key.leads.forEach(L => { if (L.id) byId[L.id] = L; });
  const path = []; let guard = 0;
  // one-line keys ('Not documented' / single result) and keys whose first lead is not 'a'
  const results = key.leads.filter(L => L.res);
  if (!Object.keys(byId).length) return results.length === 1 ? { path, result: results[0].res, page: results[0].pg } : { path, stop: 'empty' };
  let cur = byId[startLead] ? startLead : key.leads.find(L => L.id && !L.id.endsWith("'"))?.id;
  while (cur && guard++ < 60) {
    const a = byId[cur], b = byId[cur + "'"];
    if (!a) return { path, stop: 'lead-missing', at: cur };
    const pair = [a, b].filter(Boolean);
    const scored = [];
    let sum = 0;
    for (const L of pair) for (const s of L.sp) {
      const present = keySpeciesPresent(s, idx);
      if (present && typeof s.v === 'number') { sum += s.v; scored.push({ lead: L.id, c: s.c, s: s.s, v: s.v }); }
    }
    let chosen = null;
    if (choices[cur]) chosen = byId[choices[cur]];
    else {
      const ruled = pair.filter(L => L.op && L.val !== null && L.val !== undefined);
      if (ruled.length) chosen = ruled.find(L => OPS[L.op](sum, L.val)) || null;
      else if (pair.length === 1) chosen = pair[0];
    }
    path.push({ at: cur, sum, scored, evidence: scored.length, auto: !choices[cur], leads: pair.map(L => ({ id: L.id, text: L.text, rt: L.rt, res: L.res, go: L.go })), chosen: chosen && chosen.id });
    if (!chosen) return { path, stop: 'choose', at: cur };
    if (chosen.res) return { path, result: chosen.res, page: chosen.pg };
    if (chosen.go && /^[a-z]'?$/.test(chosen.go)) { cur = chosen.go.replace(/'$/, ''); continue; }
    return { path, stop: 'goto', target: chosen.go || chosen.rt };
  }
  return { path, stop: 'loop' };
}

// ---------- 3. probability key ----------
export function runProbKey(plot, pk) {
  const idx = plotIndex(plot);
  const totals = Object.fromEntries(pk.classes.map(c => [c, 0]));
  const used = [];
  for (const r of pk.rows) {
    if (!keySpeciesPresent(r, idx)) continue;
    used.push(r.c);
    for (const [c, v] of Object.entries(r.v)) if (typeof v === 'number') totals[c] += v;
  }
  const regions = pk.regions.map(g => ({ name: g.name, go: g.go, n: g.sp.filter(s => s.k.some(k => idx.any.has(k))).length }));
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  return { id: pk.id, totals, ranked, used, regions };
}

// ---------- floristic quality ----------
// All species count; non-natives (MNTaxa native_status != 'N') count as C = 0. Province picks the C column.
export function floristicQuality(plot, data, prov, opts = { minFQI: 10, flagBelow: 20 }) {
  const col = data.provC[prov] ?? 0;
  const seen = new Map();
  const byName = data._byName || (data._byName = new Map(data.species.map(s => [s.n, s])));
  for (const s of plot.species || []) {
    if (!s.n || seen.has(binom(s.n))) continue;
    const t = byName.get(s.n); if (!t) continue;
    let c = t.ns === 'N' ? t.cv[col] : 0;
    if (c === null || c === undefined) c = t.ns === 'N' ? null : 0;
    seen.set(binom(s.n), { n: s.n, c, native: t.ns === 'N' });
  }
  const vals = [...seen.values()].filter(v => v.c !== null);
  const N = vals.length;
  const meanC = N ? vals.reduce((a, v) => a + v.c, 0) / N : null;
  const fqi = N ? meanC * Math.sqrt(N) : null;
  const status = N < opts.minFQI ? 'not-reported' : N < opts.flagBelow ? 'low-count' : 'ok';
  return { N, meanC, fqi: status === 'not-reported' ? null : fqi, status,
           unassigned: [...seen.values()].filter(v => v.c === null).map(v => v.n) };
}

// ---------- 4. types and subtypes within a class ----------
// Scores sibling units (the types of a class, or the subtypes of a type) from the DNR fact sheet's
// "Native Plant Community Types in Class" text: documented range, named dominants, differentiating
// species, and cover statements. Weights are deliberately simple and are listed in TYPE_W so they
// can be calibrated against relevé data later.
export const TYPE_W = {
  prior: 0.35,            // x log(plots + 5): types described from more plots are more common
  rangeIn: 0, rangeOcc: -0.6, rangeLikely: -0.5, rangeOut: -1.6, restrictedOut: -3,
  domStrongHigh: 1.5, domStrongLow: 0.7, domStrongAbsent: -1.0, domUsual: 0.5, domAssoc: 0.3, domOcc: 0.1,
  diffPlus: 1.0, diffPlusWeak: 0.4, diffMinus: -1.0,
  coverYes: 1.2, coverNo: -1.2, dotHere: 0.6, dotNear: 0.3,
  temperature: 1.3,
};
const COVER_TXT = ['', '<5%', '5–10%', '10–25%', '25–50%', '>50%'];
const LB = [0, 0, 5, 10, 25, 50], UB = [0, 5, 10, 25, 50, 100];      // cover rank -> % bounds (index 1-5; 0 = absent)
function coverTest(rank, op, pct) {
  if (rank === null || rank === undefined) return 0;                  // unknown
  if (op === '>' || op === '>=') return rank && LB[rank] >= pct ? 1 : UB[rank] <= pct ? -1 : 0;
  if (op === 'range') { const [lo, hi] = pct; if (!rank) return lo > 0 ? -1 : 0; return LB[rank] >= lo && UB[rank] <= hi ? 1 : (UB[rank] <= lo || LB[rank] >= hi) ? -1 : 0; }
  if (op === '<' || op === '<=') return UB[rank] <= pct || !rank ? 1 : LB[rank] >= pct ? -1 : 0;
  return 0;
}
const UNIT_LAYERS = { C: ['C'], S: ['S'], H: ['H'], G: ['G'], U: ['S', 'H', 'G'] };
function presentIn(idx, keys, layer) {
  const ls = UNIT_LAYERS[layer] || null;
  for (const k of keys) {
    if (ls ? ls.some(L => idx.byLayer[L].has(k)) : idx.any.has(k)) return { k, cover: idx.coverBy(k, ls) };
  }
  return null;
}
const sectionIn = (sec, list) => (list || []).some(s => sec.split('/').includes(s));

export function rankUnits(plot, units, section, W = TYPE_W, ctx = null) {
  const idx = plotIndex(plot);
  idx.coverBy = (k, ls) => {                                          // highest cover rank of key k in the given layers
    let c = 0;
    for (const s of plot.species || []) {
      if (!s.n || (ls && !ls.includes(s.layer))) continue;
      const b = binom(s.n);
      if (b === k || 'g:' + b.split(' ')[0] === k) c = Math.max(c, s.cover || 0);
    }
    return c;
  };
  const lc = plot.layerCover || {};
  const layerHasData = L => (UNIT_LAYERS[L] || [L]).some(x => idx.byLayer[x]?.size);
  const out = units.map(u => {
    const ev = [], seen = new Set(); let s = W.prior * Math.log((u.plots || 0) + 5);
    // range
    const r = u.range || {};
    if (section) {
      if (r.restricted_to?.length && !sectionIn(section, r.restricted_to)) { s += W.restrictedOut; ev.push({ v: W.restrictedOut, t: `restricted to ${r.restricted_to.join(', ')}` }); }
      else if (sectionIn(section, r.documented)) ev.push({ v: 0, t: `documented in ${section}` });
      else if (sectionIn(section, r.occasional)) { s += W.rangeOcc; ev.push({ v: W.rangeOcc, t: `occasional in ${section}` }); }
      else if (sectionIn(section, r.likely)) { s += W.rangeLikely; ev.push({ v: W.rangeLikely, t: `likely but undocumented in ${section}` }); }
      else if (r.documented?.length || r.occasional?.length) { s += W.rangeOut; ev.push({ v: W.rangeOut, t: `not documented in ${section} (${[...(r.documented || []), ...(r.occasional || [])].join(', ')})` }); }
    }
    // relevé dots of this type on the DNR distribution map, in this LTA (ctx: {lta, near, dist})
    const tl = ctx?.dist?.[u.parent]?.t?.[u.code];
    if (tl && ctx.lta) {
      if (tl.includes(ctx.lta)) { s += W.dotHere; ev.push({ v: W.dotHere, t: 'DNR relevés of this type in this LTA' }); }
      else if (ctx.near?.some(c => tl.includes(c))) { s += W.dotNear; ev.push({ v: W.dotNear, t: 'DNR relevés of this type in an adjacent LTA' }); }
    }
    // dominants
    for (const d of u.dom || []) for (const sp of d.sp) {
      if (!sp.k.length) continue;
      const hit = presentIn(idx, sp.k, d.l);
      if (d.st === 'strong') {
        if (hit) { const v = W.domStrongLow + (W.domStrongHigh - W.domStrongLow) * Math.min(1, Math.max(0, (hit.cover - 1) / 2)) + 0.3 * Math.max(0, hit.cover - 3);
          s += v; seen.add(sp.c); ev.push({ v, t: `${sp.c} dominant (${layerWord(d.l)}, cover ${COVER_TXT[hit.cover] || '?'})` }); }
        else if (layerHasData(d.l || 'C')) { s += W.domStrongAbsent; ev.push({ v: W.domStrongAbsent, t: `${sp.c} (usual dominant) not recorded` }); }
      } else if (hit) {
        const v = d.st === 'usual' ? W.domUsual : d.st === 'associate' ? W.domAssoc : W.domOcc;
        s += v; seen.add(sp.c); ev.push({ v, t: `${sp.c} (${layerWord(d.l)})` });
      }
    }
    // differentiating species
    for (const d of u.diff || []) {
      if (!d.k.length) continue;
      const hit = presentIn(idx, d.k, d.l);
      if (!hit) continue;
      if (d.dir === '+') {
        let v = d.ab && hit.cover < 3 ? W.diffPlusWeak : W.diffPlus; const again = seen.has(d.c); if (again) v *= 0.5;
        s += v; if (!again) ev.push({ v, t: `${d.c}${d.ab ? (hit.cover >= 3 ? ' abundant' : ' (present; text says abundant)') : ''}` }); seen.add(d.c); }
      else if (!d.ab || hit.cover >= 3) { s += W.diffMinus; ev.push({ v: W.diffMinus, t: `${d.c}${d.ab ? ' abundant' : ''} (fits other types better)` }); }
    }
    // cover statements
    for (const c of u.cov || []) {
      let rank = null;
      if (c.sp) { rank = c.sp.k.length ? (presentIn(idx, c.sp.k, c.l)?.cover ?? (layerHasData(c.l || 'C') ? 0 : null)) : null; }
      else rank = lc[c.l] ? +lc[c.l] : null;
      const t = coverTest(rank, c.op, c.pct); if (!t) continue;
      const v = t > 0 ? W.coverYes : W.coverNo; s += v; ev.push({ v, t: c.text });
    }
    return { code: u.code, name: u.name, score: s, ev };
  });
  if (!out.length) return [];
  const m = Math.max(...out.map(o => o.score)); let z = 0;
  for (const o of out) { o.w = Math.exp((o.score - m) / W.temperature); z += o.w; }
  for (const o of out) o.prob = o.w / z;
  return out.sort((a, b) => b.prob - a.prob);
}
const layerWord = L => ({ C: 'canopy', S: 'subcanopy', H: 'shrub layer', G: 'ground layer', U: 'understory' }[L] || 'any layer');

// ---------- 5. DNR distribution maps: documented / possible LTAs ----------
// dist[class] = {D: [lta codes], P: [lta codes], t: {typeCode: [lta codes with relevé dots]}} read from the fact-sheet maps.
// Points near an LTA boundary take the best status among the LTAs within reach (map shading is generalized).
export const DIST_W = { D: 0, R: 0, P: -0.7, Q: -0.7, N: -2.3 };          // log-prior added to the class score: possible ~1/2, not mapped ~1/10
export function distStatus(cls, ltaCodes, dist) {
  const d = dist?.[cls]; if (!d || !ltaCodes?.length) return null;
  if (ltaCodes.some(c => d.D.includes(c))) return 'D';
  // classes described without relevés (e.g. WFs55) have maps that show only 'possible' LTAs: there that is the range
  if (!d.D.length && ltaCodes.some(c => d.P.includes(c))) return 'R';
  if (ltaCodes.some(c => d.P.includes(c))) return 'P';
  if (ltaCodes.some(c => d.Q?.includes(c))) return 'Q';      // DNR '?' : occurrence unknown / unconfirmed
  if (ltaCodes.every(c => d.U?.includes(c))) return null;     // map unreadable here: no prior
  return 'N';
}
export function distPriors(classes, ltaCodes, dist, W = DIST_W) {
  const out = {};
  for (const c of classes) { const st = distStatus(c, ltaCodes, dist); if (st) out[c] = W[st]; }
  return out;
}
// LTAs within km of the point (for boundary tolerance)
export function ltasNear(lat, lon, ecs, km = 1) {
  const y = +lat, x = +lon; if (!ecs || !isFinite(x) || !isFinite(y)) return [];
  const ky = 111.2, kx = 111.32 * Math.cos(y * Math.PI / 180), out = new Set();
  for (const f of ecs.features) {
    if (f.bbox && (x < f.bbox[0] - 0.03 || x > f.bbox[2] + 0.03 || y < f.bbox[1] - 0.02 || y > f.bbox[3] + 0.02)) continue;
    if (f.polys.some(poly => inRing(x, y, poly[0]) && !poly.slice(1).some(h => inRing(x, y, h))) || nearestKm(x, y, f.polys.flat(), kx, ky, 0.03) <= km) out.add(f.ltaCode);
  }
  return [...out];
}

// ---------- 6. minerotrophic indicators (DNR bog-species list) ----------
// Plot species not on the DNR "non-minerotrophic peatland species" list are minerotrophic indicators. The guides say they
// are absent from bogs (APn80, APn90; a few transient individuals allowed) and present but limited in the poor conifer
// swamp (APn81). Returns log-score adjustments for those classes; thresholds are in MINERO_W.
export const MINERO_W = { bogFree: 1, bogEach: -1.0, bogCap: -5, poorFree: 4, poorEach: -0.6, poorCap: -4 };
export function minerotrophic(plot, data) {
  const bog = new Set(data.bogList || []), seen = new Map();
  for (const s of plot.species || []) {
    if (!s.n) continue; const k = binom(s.n); if (bog.has(k)) continue;
    seen.set(k, Math.max(seen.get(k) || 0, s.cover || 0));
  }
  const all = new Set((plot.species || []).filter(s => s.n).map(s => binom(s.n)));
  return { n: seen.size, total: all.size, species: [...seen.keys()] };
}
export function mineroAdjust(classes, m, W = MINERO_W) {
  const out = {};
  for (const c of classes) {
    if (c === 'APn80' || c === 'APn90') out[c] = Math.max(W.bogCap, W.bogEach * Math.max(0, m.n - W.bogFree));
    else if (c === 'APn81') out[c] = Math.max(W.poorCap, W.poorEach * Math.max(0, m.n - W.poorFree));
  }
  return out;
}
// how much missing species should count: a short list is probably incomplete, so absences weigh less until ~25 species
export function completeness(plot, mode = 'auto') {
  if (mode === 'complete') return 1;
  const n = new Set((plot.species || []).filter(s => s.n).map(s => binom(s.n))).size;
  return mode === 'partial' ? Math.min(0.5, n / 25) : Math.min(1, n / 25);
}

// ---------- which keys apply ----------
// class keys in a section whose results include the class
export function keysForClass(section, code, data) {
  const out = [];
  for (const [id, k] of Object.entries(data.classKeys[section] || {}))
    if (k.leads.some(L => L.res && L.res.startsWith(code))) out.push(id);
  return out;
}
export function candidatesFor(section, data) {
  const s = data.sections.find(x => x.code === section);
  return s ? s.classes.filter(c => data.profiles[c]) : Object.keys(data.profiles);
}

// ---------- ECS subsection from a GPS point ----------
// ecs: {features:[{sec, sub, subCode, secCode, prov, polys:[[ring,...holes]]}]} in lon/lat (from scripts/build_ecs.py)
function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segKm(x, y, [x1, y1], [x2, y2], kx, ky) {          // distance from point to segment, km (local equirectangular)
  const ax = (x1 - x) * kx, ay = (y1 - y) * ky, bx = (x2 - x) * kx, by = (y2 - y) * ky;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function nearestKm(x, y, lines, kx, ky, box = 0.3) {
  let d = Infinity;
  for (const r of lines) for (let i = 1; i < r.length; i++) {
    const [x1, y1] = r[i - 1], [x2, y2] = r[i];
    if (Math.min(x1, x2) - box > x || Math.max(x1, x2) + box < x || Math.min(y1, y2) - box > y || Math.max(y1, y2) + box < y) continue;
    d = Math.min(d, segKm(x, y, r[i - 1], r[i], kx, ky));
  }
  return d;
}
export function ecsLookup(lat, lon, ecs) {
  const y = +lat, x = +lon;
  if (!ecs || !isFinite(x) || !isFinite(y) || !y || !x) return null;
  const ky = 111.2, kx = 111.32 * Math.cos(y * Math.PI / 180);
  const strip = f => { const { polys, bbox, ...rest } = f; return rest; };
  const L = ecs.lines || [], ltaLines = L.map(l => l.c), subLines = L.filter(l => l.l === 2).map(l => l.c);
  const edges = () => ({ edgeKm: nearestKm(x, y, subLines, kx, ky), ltaEdgeKm: nearestKm(x, y, ltaLines, kx, ky, 0.15) });
  const inBox = (f, pad = 0) => !f.bbox || (x >= f.bbox[0] - pad && x <= f.bbox[2] + pad && y >= f.bbox[1] - pad && y <= f.bbox[3] + pad);
  for (const f of ecs.features) {
    if (!inBox(f)) continue;
    for (const poly of f.polys) {
      if (!inRing(x, y, poly[0]) || poly.slice(1).some(h => inRing(x, y, h))) continue;
      return { ...strip(f), ...edges() };       // edgeKm: nearest subsection boundary; ltaEdgeKm: nearest LTA boundary
    }
  }
  // just outside the mapped area (shoreline, state line, simplified edge): take the nearest unit within 3 km
  let best = null;
  for (const f of ecs.features) { if (!inBox(f, 0.05)) continue; const d = nearestKm(x, y, f.polys.flat(), kx, ky, 0.05); if (d < 3 && (!best || d < best.d)) best = { f, d }; }
  return best ? { ...strip(best.f), ...edges(), offMapKm: best.d } : { outside: true };
}
