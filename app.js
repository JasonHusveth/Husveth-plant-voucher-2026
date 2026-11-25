import { rankClasses, rankUnits, runClassKey, runProbKey, floristicQuality, candidatesFor, keysForClass, binom, ecsLookup, distStatus, ltasNear, minerotrophic, mineroAdjust, completeness, PARAMS, ENGINE_VERSION } from './engine.js';

// ---------------------------------------------------------------- storage (IndexedDB, saved on every change)
const DB = 'npc-field-key', STORE = 'kv';
const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function dbGet(k) { const d = await idb(); return new Promise(r => { const q = d.transaction(STORE).objectStore(STORE).get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(undefined); }); }
async function dbPut(k, v) { const d = await idb(); return new Promise((r, j) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, k); t.oncomplete = () => r(); t.onerror = () => j(t.error); }); }
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const today = () => new Date().toISOString().slice(0, 10);
let ECS = null, DIST = null, _ctx = { key: null, v: null };
const blankPlot = settings => ({ id: '', date: today(), observer: settings.observer || '', section: '', lat: '', lon: '', acc: '', county: '', muni: '', trs: '', plotSize: '20 x 20 m (400 m²)', notes: '',
  land: { upland: '', wooded: '', landform: '', slope: '', aspect: '', flooding: '', texture: '', drainage: '', organic: '', ph: '', water: '', notes: '' },
  species: [], layerCover: { C: '', S: '', H: '', G: '' }, keyChoices: {} });
let S = { settings: { observer: 'Husveth, Jason J.', minFQI: 10, flagBelow: 20 }, plot: null, saved: [], tab: 'site' };
let D = null;            // data bundle
let saveTimer = null;
function save(now = false) {
  document.getElementById('savedState').textContent = 'Saving…';
  clearTimeout(saveTimer);
  const go = () => dbPut('state', JSON.parse(JSON.stringify(S))).then(() => { document.getElementById('savedState').textContent = 'Saved'; }).catch(() => { document.getElementById('savedState').textContent = 'NOT saved'; });
  if (now) go(); else saveTimer = setTimeout(go, 250);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(true); });
window.addEventListener('pagehide', () => save(true));

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COVER = ['<5%', '5–10', '10–25', '25–50', '>50%'];
const LAYERS = [['C', 'Canopy', '>10 m'], ['S', 'Subcanopy', '2–10 m'], ['H', 'Shrub layer', '<2 m, woody'], ['G', 'Ground layer', 'forbs, graminoids, ferns']];
const TABS = [['site', 'Site'], ['land', 'Landscape'], ['C', 'Canopy'], ['S', 'Subcanopy'], ['H', 'Shrub'], ['G', 'Ground'], ['results', 'Results'], ['saved', 'Saved']];
const comm = code => D.communities.find(c => c.code === code);
function ask(title, body, okText = 'OK') {
  const d = $('#dlg'); $('#dlgTitle').textContent = title; $('#dlgBody').textContent = body; $('#dlgOk').textContent = okText;
  return new Promise(r => { d.onclose = () => r(d.returnValue === 'ok'); d.showModal(); });
}
// system groups (Key 1) for filtering candidates
const GROUP = code => {
  const sys = code.slice(0, 2);
  if (['FD', 'MH'].includes(sys)) return 'upland-wooded';
  if (['FF', 'WF', 'FP'].includes(sys)) return 'wetland-wooded';
  if (sys === 'AP') return ['APn80', 'APn81'].includes(code) ? 'wetland-wooded' : 'wetland-open';
  if (['CT', 'RO', 'UP', 'LK', 'RV'].includes(sys)) return 'upland-open';
  return 'wetland-open';
};

// ---------------------------------------------------------------- render shell
function renderTabs() {
  const counts = Object.fromEntries(LAYERS.map(([l]) => [l, S.plot.species.filter(s => s.layer === l).length]));
  $('#tabs').innerHTML = TABS.map(([id, name]) => `<button data-tab="${id}" class="${S.tab === id ? 'on' : ''}">${name}${counts[id] ? `<span class="n">${counts[id]}</span>` : ''}</button>`).join('');
  const n = S.plot.species.length, sec = S.plot.section || 'no section';
  $('#footInfo').textContent = `${S.plot.id || 'Unnamed plot'} · ${sec} · ${n} species`;
}
function render() {
  renderTabs();
  const m = $('#main');
  m.innerHTML = S.tab === 'site' ? siteTab() : S.tab === 'land' ? landTab() : S.tab === 'results' ? resultsTab() : S.tab === 'saved' ? savedTab() : layerTab(S.tab);
  if (LAYERS.some(([l]) => l === S.tab)) { const q = $('#q'); if (q && lastQuery.layer === S.tab) { q.value = lastQuery.text; showMatches(); } }
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (!b) return; S.tab = b.dataset.tab; save(); render(); window.scrollTo(0, 0); });

// ---------------------------------------------------------------- site & landscape
// ---------- county, city/township and TRS QQ from coordinates (online, like the voucher app) ----------
// County and city/township: US Census TIGERweb (MN cities, townships and unorganized territories are county subdivisions).
// TRS QQ: MnGeo PLS service first, BLM national PLSS (CadNSDI) as fallback; same parsing as the voucher app.
const _QMAP = { A: 'NE', B: 'NW', C: 'SW', D: 'SE', '1': 'NE', '2': 'NW', '3': 'SW', '4': 'SE' };
function fetchT(url, ms) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t)); }
const titleCase = s => String(s || '').replace(/\b(city|township|unorganized territory|unorg\.?)\b/gi, w => w.replace(/\b\w/g, c => c.toUpperCase()));
async function arcPoint(url, lat, lon, fields, ms = 10000) {
  const q = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: fields, returnGeometry: 'false', f: 'json' });
  const r = await fetchT(`${url}?${q}`, ms); if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json(); if (d.error) throw new Error(d.error.message || 'service error');
  return d.features?.[0]?.attributes || null;
}
async function lookupCounty(lat, lon) {
  const a = await arcPoint('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query', lat, lon, 'NAME,BASENAME,STATE');
  return a ? (a.STATE && a.STATE !== '27' ? `${a.NAME} (state FIPS ${a.STATE})` : a.NAME) : '';
}
async function lookupMuni(lat, lon) {
  const a = await arcPoint('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/22/query', lat, lon, 'NAME,BASENAME');
  return a ? titleCase(a.NAME) : '';
}
function trsString(t, r, rdir, s, qq) { return [t && `T${t}N`, r && `R${r}${rdir}`, qq, s && `S${s}`].filter(Boolean).join(' '); }
async function lookupTRS(lat, lon) {
  try {
    const r = await fetchT(`https://imageserver.gisdata.mn.gov/cgi-bin/pls?latitude=${lat}&longitude=${lon}`, 8000);
    if (!r.ok) throw new Error('MnGeo HTTP ' + r.status);
    const txt = await r.text(); const g = tag => (txt.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1]?.trim() || '';
    if (g('e')) throw new Error(g('e'));
    const twp = g('township'), rng = g('range'), sec = g('section'), c = g('quarters').toUpperCase();
    if (!twp || !rng) throw new Error('no MnGeo TRS');
    // "AD...": letter 1 = quarter (A = NE), letter 2 = quarter-quarter; written QQ puts the quarter-quarter first -> SENE
    const qq = c.length >= 2 && _QMAP[c[1]] && _QMAP[c[0]] ? _QMAP[c[1]] + _QMAP[c[0]] : '';
    return trsString(+twp, +rng, 'W', sec ? +sec : '', qq);
  } catch (e) {
    const a = await arcPoint('https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer/3/query', lat, lon, 'TWNSHPNO,TWNSHPDIR,RANGENO,RANGEDIR,FRSTDIVNO,QSEC,QQSEC', 12000);
    if (!a || !+a.TWNSHPNO) throw new Error('no PLSS data at this point');
    return trsString(+a.TWNSHPNO, +a.RANGENO, (a.RANGEDIR || 'W').trim().toUpperCase() === 'E' ? 'E' : 'W', a.FRSTDIVNO ? +a.FRSTDIVNO : '', (a.QQSEC || '').trim() + (a.QSEC || '').trim());
  }
}
async function placeLookup(auto) {
  const p = S.plot, lat = parseFloat(p.lat), lon = parseFloat(p.lon), msg = t => { const m = $('#placeMsg'); if (m) m.textContent = t; };
  if (!isFinite(lat) || !isFinite(lon) || !lat || !lon) { if (!auto) msg('Enter coordinates or use GPS first.'); return; }
  if (!navigator.onLine) { msg('No signal: tap the button again when you have service.'); return; }
  const btn = $('#placeLookup'); if (btn) btn.disabled = true; msg('Looking up…');
  const [c, m, t] = await Promise.allSettled([lookupCounty(lat, lon), lookupMuni(lat, lon), lookupTRS(lat, lon)]);
  if (S.plot !== p) return;                                  // plot was reset or switched meanwhile
  const set = (k, r) => { if (r.status === 'fulfilled' && r.value) p[k] = r.value; };
  set('county', c); set('muni', m); set('trs', t); p.placeFrom = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  save();
  for (const k of ['county', 'muni', 'trs']) { const el = $(`[data-f="${k}"]`); if (el) el.value = p[k] || ''; }
  const failed = [['county', c], ['city/township', m], ['TRS QQ', t]].filter(([, r]) => r.status !== 'fulfilled' || !r.value).map(([n]) => n);
  msg(failed.length ? `Could not get ${failed.join(', ')}; check signal and try again, or type it in.` : 'Filled from coordinates. Edit if needed.');
  const b2 = $('#placeLookup'); if (b2) b2.disabled = false;
}
// ---------- DNR distribution maps: where each class is documented / possible, by LTA ----------
function locCtx() {
  const p = S.plot; if (!ECS || !DIST || !p.lat || !p.lon) return null;
  const key = `${p.lat},${p.lon}`; if (_ctx.key === key) return _ctx.v;
  const r = ecsLookup(p.lat, p.lon, ECS);
  const v = r && !r.outside && r.ltaCode ? { lta: r.ltaCode, ltaName: r.lta, near: ltasNear(p.lat, p.lon, ECS, 1).filter(c => c !== r.ltaCode), dist: DIST } : null;
  _ctx = { key, v }; return v;
}
const PRIOR = { D: 0, Dn: -0.35, R: 0, P: -0.7, Q: -0.7, N: -2.3 };
const STATUS_TXT = { D: 'documented in this LTA', Dn: 'documented in an adjacent LTA', R: 'in the DNR mapped range', P: 'possible in this LTA', Q: 'unknown here (DNR ?)', N: 'not mapped here' };
function classStatus(code, ctx) {
  if (!ctx) return null;
  const own = distStatus(code, [ctx.lta], ctx.dist); if (!own || own === 'D') return own;
  return ctx.near.length && distStatus(code, ctx.near, ctx.dist) === 'D' ? 'Dn' : own;
}
// one place that ranks classes the way the Results tab shows them: DNR map priors for the LTA, the minerotrophic
// rule for the acid peatlands, and absences weighted by how complete the species list is
function rankPlot(p, codes, ctx = locCtx()) {
  const pri = classPriors(codes, ctx);
  for (const [c, v] of Object.entries(mineroAdjust(codes, minerotrophic(p, D)))) pri[c] = (pri[c] || 0) + v;
  return rankClasses(p, D, codes, { ...PARAMS, absWeight: PARAMS.absWeight * completeness(p, p.listMode || 'auto') }, pri);
}
// Jason's field interpretation notes (expert/notes.json): shown when their conditions hold; never change the scoring
function fieldNotes(p, ranked, keyRes = []) {
  const top = n => new Set([...ranked.slice(0, n).map(r => r.code), ...keyRes]);
  return (D.fieldNotes || []).filter(nt => {
    const w = nt.when || {}, t = top(w.top || 3);
    if (w.any && !w.any.some(c => t.has(c))) return false;
    if (w.all && !w.all.every(c => t.has(c))) return false;
    if (w.subsection && !w.subsection.some(code => (p.subsection || '').includes(`(${code})`))) return false;
    return true;
  });
}
function classPriors(codes, ctx) { const o = {}; if (ctx) for (const c of codes) { const st = classStatus(c, ctx); if (st) o[c] = PRIOR[st]; } return o; }
function paletteClasses() {                      // every class in the section (keyed-only classes too), narrowed by the system answers
  const sec = D.sections.find(x => x.code === S.plot.section); if (!sec) return [];
  const { upland, wooded } = S.plot.land;
  return sec.classes.filter(code => { const g = GROUP(code); return (!upland || g.startsWith(upland)) && (!wooded || g.endsWith(wooded)); });
}
function paletteCard() {
  const p = S.plot;
  if (!p.section) return '<div class="card" id="palette"><h2>Possible NPCs here</h2><p class="muted">Set the section (GPS or by hand) to see the classes that apply.</p></div>';
  const ctx = locCtx(), cls = paletteClasses();
  const groups = { D: [], Dn: [], R: [], P: [], Q: [], N: [], '': [] };
  for (const c of cls) groups[ctx ? (classStatus(c, ctx) || '') : ''].push(c);
  const item = c => `<div class="pal"><b>${esc(c)}</b> ${esc(comm(c)?.name || '')}</div>`;
  const block = (k, title, open = true) => groups[k].length ? `<details ${open ? 'open' : ''}><summary><b>${title}</b> (${groups[k].length})</summary>${groups[k].map(item).join('')}</details>` : '';
  const narrowed = p.land.upland || p.land.wooded ? ` · ${[p.land.upland, p.land.wooded].filter(Boolean).join(', ')} only` : '';
  return `<div class="card" id="palette"><h2>Possible NPCs here <span class="muted">${cls.length} classes in ${esc(p.section)}${narrowed}</span></h2>
    ${ctx ? `<p class="muted">From the DNR fact-sheet distribution maps for ${esc(ctx.ltaName)} (${esc(ctx.lta)}). Unlikely classes stay listed and can still win on the plants.</p>
      ${block('D', 'Documented in this LTA')}${block('Dn', 'Documented in an adjacent LTA (within 1 km)')}${block('R', 'In the DNR mapped range (classes mapped without plot data)')}${block('P', 'Possible in this LTA')}${block('Q', 'Occurrence unknown in this LTA (DNR “?”)')}${block('N', 'Not mapped in this LTA', false)}${block('', 'No distribution map', false)}`
    : `<p class="muted">${!p.lat ? 'Add coordinates (GPS) to sort these by the DNR distribution maps.' : 'Loading distribution maps…'}</p>${block('', 'All classes in this section', false)}`}
    <p class="muted">Answer upland/wetland and wooded/open on the Landscape tab to narrow the list.</p></div>`;
}
function refreshPalette() { const el = $('#palette'); if (el) el.outerHTML = paletteCard(); }
function ecsLine() {
  const p = S.plot;
  if (!p.lat || !p.lon) return '<p class="muted">Use GPS (or type coordinates) and the ECS section and subsection are filled in from the DNR subsection map.</p>';
  if (!ECS) return '<p class="muted">Loading ECS boundaries…</p>';
  const r = ecsLookup(p.lat, p.lon, ECS);
  if (!r) return '<p class="muted">Coordinates not readable as decimal degrees.</p>';
  if (r.outside) return '<p><span class="badge warn">Outside Minnesota ECS map</span> Check the coordinates; choose the section by hand.</p>';
  const off = r.offMapKm ? ` <span class="badge warn">point is ${r.offMapKm.toFixed(1)} km off the mapped edge; nearest subsection used</span>` : '';
  const ltaNear = r.ltaEdgeKm < 0.5 ? ` <span class="badge warn">${r.ltaEdgeKm < 0.1 ? '<0.1' : r.ltaEdgeKm.toFixed(1)} km from an LTA boundary</span>` : '';
  const near = r.edgeKm < 2 ? ` <span class="badge warn">${r.edgeKm < 0.1 ? '<0.1' : r.edgeKm.toFixed(1)} km from a subsection boundary: confirm on the ground</span>` : '';
  const mismatch = p.section && p.section !== r.sec ? `<p><span class="badge bad">Section chosen is ${esc(p.section)}, but the point is in ${esc(r.sec)}</span> <button class="btn ghost" id="useEcs">Use ${esc(r.sec)}</button></p>` : '';
  return `<div class="kv" style="margin:6px 0"><span>Province</span><b>${esc(r.prov)}</b><span>Section</span><b>${esc(r.sec)} · ${esc(r.secName)} (${esc(r.secCode)})</b>
    <span>Subsection</span><b>${esc(r.sub)} (${esc(r.subCode)})${near}</b><span>LTA</span><b>${esc(r.lta || '—')}${r.ltaCode ? ` (${esc(r.ltaCode)})` : ''}${ltaNear}</b></div>${off ? `<p>${off}</p>` : ''}${mismatch}`;
}
function applyEcs(force) {                     // fill section/subsection from coordinates; never overrides a hand-picked section unless asked
  const r = ECS && ecsLookup(S.plot.lat, S.plot.lon, ECS);
  if (!r || r.outside) { S.plot.subsection = ''; S.plot.lta = ''; return; }
  S.plot.subsection = `${r.sub} (${r.subCode})`; S.plot.lta = r.lta ? `${r.lta} (${r.ltaCode})` : '';
  if (force || !S.plot.section || S.plot.sectionAuto) { S.plot.section = r.sec; S.plot.sectionAuto = true; }
}
const field = (path, label, attrs = '') => { const v = path.split('.').reduce((o, k) => o?.[k], S.plot); return `<label>${label}</label><input data-f="${path}" value="${esc(v)}" ${attrs}>`; };
const sel = (path, label, opts) => { const v = path.split('.').reduce((o, k) => o?.[k], S.plot); return `<label>${label}</label><select data-f="${path}"><option value=""></option>${opts.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`; };
function siteTab() {
  const secs = D.sections.map(s => `<option value="${s.code}" ${S.plot.section === s.code ? 'selected' : ''}>${s.code} · ${esc(s.name)} (${s.prov})</option>`).join('');
  return `<section class="tab on"><div class="card"><h2>Plot</h2>
    ${field('id', 'Plot ID')}<div class="row"><div>${field('date', 'Date', 'type="date"')}</div><div>${field('observer', 'Observer')}</div></div>
    <label>Ecological section (selects which keys apply)</label><select data-f="section"><option value="">Choose section…</option>${secs}</select>
    ${field('plotSize', 'Plot size')}</div>
    <div class="card"><h2>Location</h2><div class="row3"><div>${field('lat', 'Latitude', 'inputmode="decimal"')}</div><div>${field('lon', 'Longitude', 'inputmode="decimal"')}</div><div>${field('acc', 'Accuracy (m)', 'inputmode="decimal"')}</div></div>
    <p><button class="btn ghost" id="gps">Use GPS</button> <span class="muted" id="gpsMsg"></span></p>
    <div class="row"><div>${field('county', 'County')}</div><div>${field('muni', 'City / Township')}</div></div>
    ${field('trs', 'TRS QQ', 'placeholder="e.g. T30N R20W SENE S12"')}
    <p><button class="btn ghost" id="placeLookup">Look up county, city/township &amp; TRS QQ</button> <span class="muted" id="placeMsg">${S.plot.placeFrom && S.plot.lat && S.plot.placeFrom !== `${(+S.plot.lat).toFixed(6)},${(+S.plot.lon).toFixed(6)}` ? 'Coordinates changed since the last lookup: look up again.' : ''}</span></p>
    <div id="ecsBox">${ecsLine()}</div></div>
    ${paletteCard()}
    <div class="card"><label>Notes</label><textarea data-f="notes">${esc(S.plot.notes)}</textarea></div></section>`;
}
function landTab() {
  const L = S.plot.land;
  const seg = (key, opts) => `<div class="seg" data-seg="${key}">${opts.map(([v, t]) => `<button data-v="${v}" class="${L[key] === v ? 'on' : ''}">${t}</button>`).join('')}</div>`;
  return `<section class="tab on"><div class="card"><h2>System group (Key 1)</h2>
    <label>Upland or wetland</label>${seg('upland', [['upland', 'Upland'], ['wetland', 'Wetland'], ['', 'Not sure']])}
    <label>Wooded or open</label>${seg('wooded', [['wooded', 'Wooded (tree cover >25%)'], ['open', 'Open'], ['', 'Not sure']])}
    <p class="muted">Answers here narrow the candidates. Leave "Not sure" to score every class in the section.</p></div>
    ${paletteCard()}
    <div class="card"><h2>Landscape & soils</h2>
    ${sel('land.landform', 'Landform', ['Moraine / till plain', 'Outwash / sand plain', 'Lake plain', 'Floodplain / terrace', 'Stream valley / ravine', 'Bluff / steep slope', 'Bedrock outcrop / cliff', 'Talus', 'Lakeshore / beach', 'Peatland (basin)', 'Peatland (water track)', 'Depression / basin', 'Seepage slope', 'Dune / beach ridge'])}
    <div class="row"><div>${field('land.slope', 'Slope (%)', 'inputmode="decimal"')}</div><div>${sel('land.aspect', 'Aspect', ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'Level'])}</div></div>
    ${sel('land.flooding', 'Flooding', ['None', 'Occasional', 'Annual / frequent', 'Seasonally saturated', 'Permanently saturated', 'Standing water'])}
    <div class="row"><div>${sel('land.texture', 'Soil texture', ['Sand', 'Loamy sand', 'Sandy loam', 'Loam', 'Silt loam', 'Clay loam', 'Clay', 'Muck', 'Peat', 'Bedrock / rock'])}</div><div>${sel('land.drainage', 'Drainage class', ['Excessively', 'Somewhat excessively', 'Well', 'Moderately well', 'Somewhat poorly', 'Poorly', 'Very poorly'])}</div></div>
    <div class="row3"><div>${field('land.organic', 'Organic depth (in)', 'inputmode="decimal"')}</div><div>${field('land.ph', 'pH', 'inputmode="decimal"')}</div><div>${field('land.water', 'Water depth (in)', 'inputmode="decimal"')}</div></div>
    <label>Notes</label><textarea data-f="land.notes">${esc(L.notes)}</textarea></div></section>`;
}
$('#main').addEventListener('input', e => {
  const f = e.target.dataset.f; if (!f) return;
  const ks = f.split('.'); let o = S.plot; ks.slice(0, -1).forEach(k => o = o[k]); o[ks.at(-1)] = e.target.value;
  if (f === 'section') S.plot.sectionAuto = false;
  if (f === 'section' || f === 'id') renderTabs();
  if (f === 'lat' || f === 'lon') { applyEcs(false); const b = $('#ecsBox'); if (b) b.innerHTML = ecsLine(); refreshPalette(); const sc = $('[data-f="section"]'); if (sc) sc.value = S.plot.section; renderTabs(); }
  save();
});
$('#main').addEventListener('click', async e => {
  const t = e.target;
  const segb = t.closest('[data-seg] button');
  if (segb) { S.plot.land[segb.parentElement.dataset.seg] = segb.dataset.v; save(); render(); return; }
  if (t.id === 'placeLookup') { placeLookup(false); return; }
  if (t.id === 'useEcs') { applyEcs(true); save(); render(); renderTabs(); return; }
  if (t.id === 'gps') {
    $('#gpsMsg').textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(p => {
      S.plot.lat = p.coords.latitude.toFixed(6); S.plot.lon = p.coords.longitude.toFixed(6); S.plot.acc = Math.round(p.coords.accuracy); applyEcs(false); save(); render(); renderTabs(); placeLookup(true);
    }, err => { $('#gpsMsg').textContent = 'GPS failed: ' + err.message; }, { enableHighAccuracy: true, timeout: 20000 });
    return;
  }
  const add = t.closest('[data-add]'); if (add) { addSpecies(add.dataset.add, S.tab); return; }
  const lcov = t.closest('[data-lcov]'); if (lcov) { const [L, r] = lcov.dataset.lcov.split('§'); S.plot.layerCover ||= {}; S.plot.layerCover[L] = +S.plot.layerCover[L] === +r ? '' : r; save(); render(); return; }
  const lm = t.closest('[data-lm]'); if (lm) { S.plot.listMode = lm.dataset.lm; save(); render(); return; }
  const vc = t.closest('[data-viewclass]'); if (vc) { S.viewClass = vc.dataset.viewclass; save(); render(); return; }
  const cov = t.closest('[data-cov]'); if (cov) { const s = S.plot.species.find(x => x.id === cov.dataset.id); s.cover = +cov.dataset.cov; save(); render(); return; }
  const del = t.closest('[data-del]'); if (del) { S.plot.species = S.plot.species.filter(x => x.id !== del.dataset.del); save(); render(); return; }
  const ch = t.closest('[data-choose]'); if (ch) { const [kid, at, lead] = ch.dataset.choose.split('§'); (S.plot.keyChoices[kid] ||= {})[at] = lead; save(); render(); return; }
  const unch = t.closest('[data-unchoose]'); if (unch) { const [kid, at] = unch.dataset.unchoose.split('§'); if (S.plot.keyChoices[kid]) delete S.plot.keyChoices[kid][at]; save(); render(); return; }
  if (t.id === 'savePlot') { savePlot(); return; }
  if (t.id === 'copyExport') { const ta = $('#exportText'); navigator.clipboard.writeText(ta.value).then(() => { $('#copyMsg').textContent = 'Copied.'; }).catch(() => { ta.select(); $('#copyMsg').textContent = 'Text selected; copy it with your device.'; }); return; }
  if (t.id === 'exportCsv') { exportCsv(); return; }
  if (t.id === 'exportJson') { download(`npc-plots-${today()}.json`, JSON.stringify(S.saved, null, 1), 'application/json'); return; }
  const load = t.closest('[data-load]'); if (load) { if (await ask('Open saved plot?', 'This replaces the plot on screen. The plot on screen is not lost if it has been saved.', 'Open')) { S.plot = JSON.parse(JSON.stringify(S.saved[+load.dataset.load])); S.plot.layerCover ||= { C: '', S: '', H: '', G: '' }; S.viewClass = ''; S.tab = 'site'; save(); render(); } return; }
  const rm = t.closest('[data-rm]'); if (rm) { if (await ask('Delete saved plot?', S.saved[+rm.dataset.rm].id || 'Unnamed plot', 'Delete')) { S.saved.splice(+rm.dataset.rm, 1); save(); render(); } return; }
});

// ---------------------------------------------------------------- species entry
let SP = null; const lastQuery = { layer: '', text: '' };
function buildSearch() {
  SP = D.species.map(s => ({ s, hay: (s.n + ' ' + s.c + ' ' + s.o).toLowerCase() }));
  for (const [old, cur] of Object.entries(D.aliases || {})) { const t = SP.find(x => x.s.n === cur); if (t) t.hay += ' ' + old.toLowerCase(); }
}
function matches(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean); if (!words.length) return [];
  const out = [];
  for (const x of SP) if (words.every(w => x.hay.includes(w))) {
    const score = (x.s.n.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1) + (x.s.c.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1) + (x.s.r === 'species' ? 0 : 0.5);
    out.push([score, x.s]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1].n.localeCompare(b[1].n)).slice(0, 15).map(x => x[1]);
}
// ---------- likely species for a layer: frequency in the likely classes here, weighted by how likely each class is ----------
// Before species are entered the class weights come from the section, the Landscape answers and the DNR distribution maps
// for the plot's LTA; once 3+ species are entered they come from the probability ranking itself.
const WOODY = new Set(['D', 'E', 'B', 'C']);
function keyName(key) {
  const D_ = D._byKey || (D._byKey = (() => { const m = new Map(); for (const x of D.species) if (!m.has(x.k) || x.r === 'species') m.set(x.k, x); return m; })());
  for (const k of key.split('|')) if (!k.startsWith('g:') && !k.startsWith('b:') && D_.has(k)) return D_.get(k);
  return null;
}
function likelySpecies(layer, n = 20) {
  const p = S.plot; if (!p.section) return [];
  const cls = paletteClasses().filter(c => D.profiles[c]); if (!cls.length) return [];
  const ctx = locCtx(); let w = {};
  if (p.species.length >= 3) for (const r of rankPlot(p, cls, ctx)) w[r.code] = r.prob;
  else for (const c of cls) { const st = classStatus(c, ctx); w[c] = Math.exp(st ? PRIOR[st] : 0); }
  const z = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const score = new Map();
  const add = (key, f, c) => score.set(key, (score.get(key) || 0) + w[c] / z * f / 100);
  for (const c of cls) {
    const pr = D.profiles[c];
    if (layer === 'C' || layer === 'S') {
      for (const [k, L] of Object.entries(pr.t)) { const f = layer === 'C' ? L.C?.[0] : Math.max(L.S?.[0] || 0, L.U?.[0] || 0); if (f) add(k, f, c); }
    } else if (layer === 'H') {
      for (const [k, L] of Object.entries(pr.t)) { const f = Math.max(L.H?.[0] || 0, L.U?.[0] || 0); if (f) add(k, f, c); }
      for (const [k, [f]] of Object.entries(pr.g)) { const sp = keyName(k); if (sp && WOODY.has((sp.p || '').split(',')[0]) && !pr.t[k]) add(k, f, c); }
    } else {
      for (const [k, [f]] of Object.entries(pr.g)) { const sp = keyName(k); if (sp && !WOODY.has((sp.p || '').split(',')[0])) add(k, f, c); }
    }
  }
  const have = new Set(p.species.filter(s => s.layer === layer).map(s => binom(s.n)));
  const out = [];
  for (const [k, v] of [...score].sort((a, b) => b[1] - a[1])) {
    const sp = keyName(k); if (!sp || have.has(sp.k) || out.some(o => o.sp.n === sp.n)) continue;
    out.push({ sp, pct: Math.round(v * 100) }); if (out.length >= n) break;
  }
  return out;
}
function suggestionsHtml(layer) {
  const L = likelySpecies(layer);
  if (!S.plot.section) return '<p class="muted">Set the section on the Site tab to see likely species here.</p>';
  if (!L.length) return '';
  const basis = S.plot.species.length >= 3 ? 'the classes your plot ranks highest' : locCtx() ? 'the classes likely in this LTA' : `the classes in ${esc(S.plot.section)}`;
  return `<p class="muted" style="margin:8px 0 4px">Most likely in this layer, from ${basis} (tap to add; type above to search everything):</p>
    <div class="results">${L.map(({ sp, pct }) => `<div data-add="${esc(sp.n)}"><b>${esc(sp.c || sp.n)}</b> <i>${esc(sp.n)}</i> <span class="muted">· ~${pct}% of plots</span></div>`).join('')}</div>`;
}
function showMatches() {
  const q = $('#q').value; lastQuery.text = q; lastQuery.layer = S.tab;
  if (!q.trim()) { $('#matches').innerHTML = suggestionsHtml(S.tab); return; }
  const m = matches(q);
  $('#matches').innerHTML = m.length ? `<div class="results">${m.map(s => `<div data-add="${esc(s.n)}"><b>${esc(s.c || s.n)}</b> <i>${esc(s.n)}${s.ns && s.ns !== 'N' ? ' · non-native' : ''}</i></div>`).join('')}</div>` : (q ? '<p class="muted">No match in MNTaxa 2026.</p>' : '');
}
$('#main').addEventListener('keyup', e => { if (e.target.id === 'q') showMatches(); });
$('#main').addEventListener('input', e => { if (e.target.id === 'q' && !e.target.value) showMatches(); });
function addSpecies(name, layer) {
  if (!S.plot.species.some(s => s.n === name && s.layer === layer))
    S.plot.species.push({ id: Math.random().toString(36).slice(2, 9), n: name, layer, cover: layer === 'G' ? 1 : 2 });
  lastQuery.text = ''; save(); render(); $('#q')?.focus();
}
function layerTab(layer) {
  const [, name, desc] = LAYERS.find(l => l[0] === layer);
  const list = S.plot.species.filter(s => s.layer === layer);
  const byName = D._byName || (D._byName = new Map(D.species.map(s => [s.n, s])));
  return `<section class="tab on"><div class="card"><h2>${name} <span class="muted">${desc}</span></h2>
    <label>Total cover of this layer (used for type and subtype cover statements)</label>
    <div class="cov">${COVER.map((c, i) => `<button data-lcov="${layer}§${i + 1}" class="${+(S.plot.layerCover?.[layer]) === i + 1 ? 'on' : ''}">${c}</button>`).join('')}</div>
    <label>Add species</label>
    <div class="search"><input id="q" placeholder="Type common or scientific name (old names work too)" autocomplete="off" autocapitalize="off"></div><div id="matches">${suggestionsHtml(layer)}</div></div>
    <div class="card">${list.length ? list.map(s => { const t = byName.get(s.n) || {}; return `<div class="sp"><div class="nm">${esc(t.c || s.n)}<i>${esc(s.n)}</i></div><button class="x" data-del="${s.id}" aria-label="Remove">×</button>
      <div class="cov">${COVER.map((c, i) => `<button data-cov="${i + 1}" data-id="${s.id}" class="${s.cover === i + 1 ? 'on' : ''}">${c}</button>`).join('')}</div></div>`; }).join('')
      : '<p class="muted">No species in this layer yet.</p>'}</div></section>`;
}

// ---------------------------------------------------------------- results
function candidates() {
  let c = S.plot.section ? candidatesFor(S.plot.section, D) : Object.keys(D.profiles);
  const { upland, wooded } = S.plot.land;
  if (upland || wooded) c = c.filter(code => { const g = GROUP(code); return (!upland || g.startsWith(upland)) && (!wooded || g.endsWith(wooded)); });
  return c;
}
function resultsTab() {
  const p = S.plot;
  if (!p.section) return `<section class="tab on"><div class="card"><h2>Results</h2><p>Choose the ecological section on the Site tab first; it decides which keys and classes apply.</p></div></section>`;
  if (p.species.length < 3) return `<section class="tab on"><div class="card"><h2>Results</h2><p>Add at least a few species to score the plot.</p></div></section>`;
  const sec = D.sections.find(s => s.code === p.section);
  const cands = candidates();
  const ctx = locCtx();
  const ranked = rankPlot(p, cands, ctx);
  const top = ranked[0];
  // key run for the top-ranked class (and the runner-up when it uses a different key)
  const keyIds = [...new Set(ranked.slice(0, 4).flatMap(r => keysForClass(p.section, r.code, D).slice(0, 1)))].slice(0, 3);
  const runs = keyIds.map(id => ({ id, key: D.classKeys[p.section][id], run: runClassKey(p, D.classKeys[p.section][id], 'a', p.keyChoices[id] || {}) }));
  // headline key: one whose result agrees with the top-ranked class, else the first key that finished
  const keyed = runs.find(r => r.run.result && top && r.run.result.startsWith(top.code)) || runs.find(r => r.run.result);
  const defaults = r => r.run.path.filter(st => st.auto && st.evidence === 0 && st.leads.length > 1).length;
  const keyList = runs.length > 1 ? `<p class="muted" style="margin-top:6px"><b>All DNR keys run:</b> ${runs.map(r => `${esc(r.id)} ${esc(r.key.title || '')} → <b>${esc(r.run.result || (r.run.stop === 'choose' ? 'needs your choice' : 'stopped'))}</b>${defaults(r) ? ` <span class="badge warn">${defaults(r)} couplet${defaults(r) > 1 ? 's' : ''} by default</span>` : ''}`).join(' · ')}</p>` : '';
  const agree = keyed && top && keyed.run.result.startsWith(top.code);
  const notesHtml = fieldNotes(p, ranked, runs.map(r => r.run.result?.slice(0, 5)).filter(Boolean)).map(nt => `<div class="step chosen" style="margin-top:10px"><b>Field note (${esc(nt.author)})</b><br>${esc(nt.text)}</div>`).join('');
  const fq = floristicQuality(p, D, sec.prov, { minFQI: S.settings.minFQI, flagBelow: S.settings.flagBelow });
  const name = c => esc(comm(c)?.name || '');
  // headline
  let head = '';
  if (keyed && top) head = `<div class="card"><h2>Summary</h2>
    <div class="verdict">${esc(keyed.run.result)} ${name(keyed.run.result.slice(0, 5))}</div>
    <p>${agree ? `<span class="badge good">Key and probabilities agree</span> The probability ranking puts ${esc(top.code)} first at ${Math.round(top.prob * 100)}%.`
      : `<span class="badge warn">Key and probabilities disagree</span> The key gives ${esc(keyed.run.result)}; the probability ranking puts ${esc(top.code)} first (${Math.round(top.prob * 100)}%). Check the fact sheets for both.`}</p>${keyList}${notesHtml}</div>`;
  else if (top) head = `<div class="card"><h2>Summary</h2><div class="verdict">${esc(top.code)} ${name(top.code)}</div><p>Most probable class at ${Math.round(top.prob * 100)}%. ${runs.some(r => r.run.stop === 'choose') ? 'The key needs your answer below to finish.' : ''}</p>${keyList}${notesHtml}</div>`;
  // probability ranking
  const rank = `<div class="card"><h2>Probability ranking <span class="muted">${cands.length} classes in ${esc(p.section)}${ranked.some(r => r.prov) ? ', some provisional' : ''}</span></h2>
    ${ranked.slice(0, 8).map(r => `<div class="rank"><span class="code">${r.code}</span><span>${name(r.code)}${ctx && classStatus(r.code, ctx) ? ` <span class="badge ${{ D: 'good', Dn: 'good', R: 'good', P: '', Q: '', N: 'warn' }[classStatus(r.code, ctx)]}">${STATUS_TXT[classStatus(r.code, ctx)]}</span>` : ''}</span>${r.expert ? ' <span class="badge">field-based profile (J. Husveth); no DNR frequency table</span>' : r.prov ? ' <span class="badge warn">provisional: no DNR frequency table</span>' : ''}<span class="pct">${r.prob < 0.01 ? '<1' : Math.round(r.prob * 100)}%</span>
      <div class="bar"><span style="width:${Math.max(1, r.prob * 100)}%"></span></div>
      <div class="why">${r.hits.length ? 'Found: ' + feats(r.hits, 6) : ''}${r.misses.length ? `<br>Expected, not recorded: ${feats(r.misses, 5)}` : ''}</div></div>`).join('')}
    ${(() => { const m = minerotrophic(p, D); const peat = ranked.slice(0, 8).some(r => /^(AP|FP|OP)/.test(r.code));
      return peat ? `<p class="muted"><b>Minerotrophic indicators:</b> ${m.n} of ${m.total} species are not on the DNR bog-species list${m.n ? ` (${m.species.slice(0, 8).map(k => esc(keyName(k)?.c || k)).join(', ')}${m.n > 8 ? '…' : ''})` : ''}. Bogs (APn80, APn90) are marked down for more than ${1} and the poor conifer swamp (APn81) for more than 4.</p>` : ''; })()}
    <div class="row" style="align-items:center"><label style="margin:0">Species list</label><div class="seg" data-listmode>${[['auto', 'Auto'], ['partial', 'Partial'], ['complete', 'Complete relevé']].map(([v, t]) => `<button data-lm="${v}" class="${(p.listMode || 'auto') === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>
    <p class="muted">Missing species count ${Math.round(completeness(p, p.listMode || 'auto') * 100)}% as much as in a complete relevé (Auto scales with the number of species entered, full weight at 25).</p>
    <p class="muted">Classes marked provisional have no DNR frequency table; their profile is estimated from the fact-sheet description, indicator tables and the probability key. Cliffs, talus and shores are reached by the key only.${ctx ? ` Ranking includes the DNR distribution maps for ${esc(ctx.ltaName)}: classes possible here count about half, classes not mapped here about a tenth, before the plants are weighed.` : ''}</p></div>`;
  // keys
  const keys = runs.map(({ id, key, run }) => `<div class="card"><h2>DNR key ${esc(id)} <span class="muted">${esc(key.title || '')} · ${key.book} p. ${key.pages.join(', ')}</span></h2>
    ${run.path.map(st => `<div class="step chosen"><b>Couplet ${esc(st.at)}</b> · score ${st.sum}${st.scored.length ? ` (${st.scored.map(x => `${esc(x.c)} ${x.v > 0 ? '+' : ''}${x.v}`).join(', ')})` : ''}<br>
       ${st.chosen ? `→ ${esc(st.chosen)}: ${esc(trim(st.leads.find(l => l.id === st.chosen)?.text, 160))} ${p.keyChoices[id]?.[st.at] ? `<button class="btn ghost" style="padding:2px 8px;font-size:12px" data-unchoose="${id}§${st.at}">undo</button>` : ''}` : ''}
       ${st.chosen && st.auto && st.evidence === 0 && st.leads.length > 1 ? `<div><span class="badge warn">No key species recorded at this couplet</span> The book's rule defaults to ${esc(st.chosen)}. Confirm by description:</div>
         <div class="choice">${st.leads.map(l => `<button data-choose="${id}§${st.at}§${l.id}"><b>${esc(l.id)}.</b> ${esc(trim(l.text, 220))}${l.res ? ` <b>→ ${esc(l.res)}</b>` : ''}</button>`).join('')}</div>` : ''}</div>`).join('')}
    ${run.stop === 'choose' ? `<p><b>This couplet is not scored; choose the description that fits:</b></p><div class="choice">${run.path.at(-1).leads.map(l => `<button data-choose="${id}§${run.path.at(-1).at}§${l.id}"><b>${esc(l.id)}.</b> ${esc(l.text || '')}${l.res ? ` <b>→ ${esc(l.res)}</b>` : ''}</button>`).join('')}</div>` : ''}
    ${run.result ? `<p class="verdict">→ ${esc(run.result)} ${name(run.result.slice(0, 5))} <span class="muted">p. ${run.page ?? ''}</span></p>` : ''}
    ${run.stop && run.stop !== 'choose' ? `<p class="muted">Key stopped (${esc(run.stop)} ${esc(run.target || '')}).</p>` : ''}</div>`).join('');
  // probability keys (wooded classes, LMF & EBF sections)
  const keyRes = runs.map(r => r.run.result?.slice(0, 5)).filter(Boolean);
  const pks = (D.probKeys[p.section] || []).filter(k => k.classes.length && k.classes.some(c => ranked.slice(0, 6).some(r => r.code === c) || keyRes.includes(c)));
  const pk = pks.map(k => { const r = runProbKey(p, k); const tot = r.ranked.reduce((a, x) => a + x[1], 0) || 1;
    return `<div class="card"><h2>DNR probability key ${esc(k.id)} <span class="muted">${k.book} p. ${k.page}</span></h2>
      ${r.ranked.map(([c, v]) => `<div class="rank"><span class="code">${c}</span><span>${name(c)}</span><span class="pct">${v} pts</span><div class="bar"><span style="width:${100 * v / tot}%"></span></div></div>`).join('')}
      <p class="muted">${r.used.length} of the key's ${k.rows.length} species recorded. Highest score is the most probable class (the DNR reports 70–80% accuracy).</p></div>`; }).join('');
  // types and subtypes within a class (keyed class first, then the top of the probability ranking)
  const clsOpts = [...new Set([keyed?.run.result?.slice(0, 5), ...ranked.slice(0, 3).map(r => r.code)].filter(c => c && D.types?.[c]))];
  const cls = clsOpts.includes(S.viewClass) ? S.viewClass : clsOpts[0] || (keyed?.run.result || top?.code || '').slice(0, 5);
  const typesCard = cls ? typeCard(cls, clsOpts, p) : '';
  // FQI
  const fqCard = `<div class="card"><h2>Floristic quality <span class="muted">${esc(sec.prov)} C values, all species, non-natives C = 0</span></h2>
    <div class="kv"><span>Species (N)</span><b>${fq.N}</b><span>Mean C</span><b>${fq.meanC === null ? '–' : fq.meanC.toFixed(2)}${fq.status === 'not-reported' ? ' <span class="badge warn">provisional</span>' : ''}</b>
    <span>FQI</span><b>${fq.status === 'not-reported' ? `not reported (fewer than ${S.settings.minFQI} species)` : fq.fqi.toFixed(1)}${fq.status === 'low-count' ? ' <span class="badge warn">low species count</span>' : ''}</b></div>
    ${fq.unassigned.length ? `<p class="muted">No C value in MNTaxa for: ${fq.unassigned.map(esc).join(', ')} (left out).</p>` : ''}</div>`;
  return `<section class="tab on">${head}${rank}${keys}${pk}${typesCard}${fqCard}
    <div class="card"><button class="btn" id="savePlot">Save plot to list</button> <span class="muted">Engine ${ENGINE_VERSION} · data ${esc(D.version)}</span></div></section>`;
}
function typeCard(cls, opts, p) {
  const T = D.types?.[cls]; const name = c => esc(comm(c)?.name || '');
  const desc = comm(cls)?.desc;
  const chips = opts.length > 1 ? `<div class="seg" style="margin-bottom:8px">${opts.map(c => `<button data-viewclass="${c}" class="${c === cls ? 'on' : ''}">${c}</button>`).join('')}</div>` : '';
  const head = `<div class="card"><h2>Types in ${esc(cls)} ${name(cls)}</h2>${chips}`;
  if (!T) return head + `${desc ? `<p class="desc">${esc(desc.text)}</p>` : ''}<p class="muted">No type descriptions available for this class.</p></div>`;
  const types = T.units.filter(u => u.lv === 'type');
  const unitRow = (r, u) => {
    const rg = u.range || {};
    const range = [rg.restricted_to?.length ? 'restricted to ' + rg.restricted_to.join(', ') : '', rg.documented?.length && rg.documented.join() !== (rg.restricted_to || []).join() ? 'documented: ' + rg.documented.join(', ') : '',
      rg.occasional?.length ? 'occasional: ' + rg.occasional.join(', ') : '', rg.likely?.length ? 'likely: ' + rg.likely.join(', ') : ''].filter(Boolean).join(' · ') || rg.note || '';
    const plus = r.ev.filter(e => e.v > 0), minus = r.ev.filter(e => e.v < 0);
    return `<div class="rank"><span class="code">${esc(u.code)}</span><span>${esc(u.name)}</span><span class="pct">${types.length > 1 || u.lv === 'subtype' ? (r.prob < 0.01 ? '<1' : Math.round(r.prob * 100)) + '%' : ''}</span>
      ${types.length > 1 || u.lv === 'subtype' ? `<div class="bar"><span style="width:${Math.max(1, r.prob * 100)}%"></span></div>` : ''}
      <div class="why">${plus.length ? '<span class="badge good">+</span> ' + plus.map(e => esc(e.t)).join('; ') : ''}${minus.length ? `${plus.length ? '<br>' : ''}<span class="badge bad">−</span> ` + minus.map(e => esc(e.t)).join('; ') : ''}
      <details><summary>Description${u.plots ? ` · ${u.plots} plots` : u.fo ? ' · field observations' : ''}${range ? ' · ' + esc(range) : ''}</summary><p class="desc">${esc(u.text || 'No description printed.')}</p>
      ${u.site.length ? `<p class="muted">Check on site: ${u.site.map(esc).join('; ')}</p>` : ''}</details></div></div>`;
  };
  const tctx = locCtx();
  const rankList = list => rankUnits(p, list, p.section, undefined, tctx).map(r => unitRow(r, list.find(u => u.code === r.code))).join('');
  const rt = types.length ? rankUnits(p, types, p.section, undefined, tctx) : [];
  const topType = rt[0] && types.find(u => u.code === rt[0].code);
  const subs = topType ? T.units.filter(u => u.lv === 'subtype' && u.parent === topType.code) : [];
  return head + `${T.intro ? `<p class="muted">${esc(T.intro)}</p>` : ''}
    ${types.length ? rt.map(r => unitRow(r, types.find(u => u.code === r.code))).join('') : ''}
    ${subs.length ? `<h3>Subtypes of ${esc(topType.code)}</h3>${rankList(subs)}` : ''}
    <p class="muted">Scored from the DNR fact sheet type descriptions: documented range, named dominants, differentiating species and cover statements (enter layer cover on each layer tab). Landscape and soil statements are listed for you to check. ${desc ? `Class fact sheet: ${desc.book} p. ${desc.page}.` : ''}</p></div>`;
}
const LAYNAME = { C: 'canopy', S: 'subcanopy', H: 'shrub layer' };
function feats(list, n) {
  const seen = new Map();
  for (const f of list) { const nm = label(f.key); const lay = f.layers ? (f.layers.length === 1 ? LAYNAME[f.layers[0]] : 'understory') : null;
    if (!seen.has(nm)) seen.set(nm, new Set()); if (lay) seen.get(nm).add(lay); }
  return [...seen].slice(0, n).map(([nm, ls]) => esc(nm) + (ls.size ? ` <span class="muted">(${[...ls].join(', ')})</span>` : '')).join(', ');
}
const trim = (s, n) => !s ? '' : s.length > n ? s.slice(0, n) + '…' : s;
function label(key) {
  const k = key.split('|')[0]; if (k.startsWith('g:')) return k.slice(2).replace(/^./, c => c.toUpperCase()) + ' spp.';
  const t = D.species.find(s => s.k === k); return t ? (t.c || t.n) : k;
}

// ---------------------------------------------------------------- saved plots & export
function savePlot() {
  const sec = D.sections.find(s => s.code === S.plot.section);
  const cands = S.plot.section ? candidates() : [];
  const ranked = S.plot.section ? rankPlot(S.plot, cands) : [];
  const rec = JSON.parse(JSON.stringify(S.plot));
  rec.savedAt = new Date().toISOString();
  rec.result = ranked.slice(0, 3).map(r => ({ code: r.code, prob: +r.prob.toFixed(3) }));
  if (sec) rec.fqi = floristicQuality(S.plot, D, sec.prov, S.settings);
  const i = S.saved.findIndex(x => x.id && x.id === rec.id);
  if (i >= 0) S.saved[i] = rec; else S.saved.unshift(rec);
  save(true); S.tab = 'saved'; render();
}
function savedTab() {
  return `<section class="tab on"><div class="card"><h2>Saved plots (${S.saved.length})</h2>
    ${S.saved.length ? S.saved.map((p, i) => `<div class="saved"><div><b>${esc(p.id || 'Unnamed plot')}</b> · ${esc(p.date)} · ${esc(p.section)}<br><span class="muted">${p.species.length} species · ${(p.result || []).map(r => `${r.code} ${Math.round(r.prob * 100)}%`).join(', ')}</span></div>
      <div><button class="btn ghost" data-load="${i}">Open</button> <button class="x" data-rm="${i}" aria-label="Delete">×</button></div></div>`).join('') : '<p class="muted">Plots you save from the Results tab appear here.</p>'}
    <p><button class="btn ghost" id="exportCsv">Export CSV</button> <button class="btn ghost" id="exportJson">Export JSON (backup)</button></p><div id="exportBox"></div></div></section>`;
}
function exportCsv() {
  const rows = [['plot_id', 'date', 'observer', 'county', 'city_township', 'trs_qq', 'section', 'subsection', 'lta', 'lat', 'lon', 'layer', 'scientific_name', 'common_name', 'cover_rank', 'cover_class', 'top_class', 'top_prob', 'mean_c', 'fqi']];
  const byName = new Map(D.species.map(s => [s.n, s]));
  for (const p of S.saved) for (const s of p.species) rows.push([p.id, p.date, p.observer, p.county || '', p.muni || '', p.trs || '', p.section, p.subsection || '', p.lta || '', p.lat, p.lon, s.layer, s.n, byName.get(s.n)?.c || '', s.cover, COVER[s.cover - 1],
    p.result?.[0]?.code || '', p.result?.[0]?.prob ?? '', p.fqi?.meanC?.toFixed?.(2) ?? '', p.fqi?.fqi?.toFixed?.(1) ?? '']);
  download(`npc-plots-${today()}.csv`, rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
}
function download(name, text, type) {
  try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); } catch {}
  // always also show the text, so it can be copied where file downloads are blocked
  const box = $('#exportBox'); if (!box) return;
  box.innerHTML = `<label for="exportText">${esc(name)}</label><textarea id="exportText" readonly style="min-height:160px">${esc(text)}</textarea>
    <p><button class="btn ghost" id="copyExport">Copy to clipboard</button> <span class="muted" id="copyMsg">If no file downloaded, copy this text into a file.</span></p>`;
}

// ---------------------------------------------------------------- hard reset
$('#resetBtn').addEventListener('click', async () => {
  if (!await ask('Reset this plot?', 'Every field and species on this plot will be cleared. Saved plots are not affected.', 'Reset')) return;
  S.plot = blankPlot(S.settings); S.viewClass = ''; S.tab = 'site'; save(true); render();
});

// first open: a clearly labelled example plot so the Results tab shows what the app does
function examplePlot(settings) {
  const p = blankPlot(settings);
  Object.assign(p, { id: 'EXAMPLE (press Reset plot to start your own)', section: 'MIM', county: 'Example', notes: 'Example plot: sugar maple-basswood stand. Not real field data.' });
  Object.assign(p.land, { upland: 'upland', wooded: 'wooded', landform: 'Moraine / till plain', drainage: 'Well', texture: 'Silt loam' });
  const add = (layer, list) => list.forEach(([n, cover]) => p.species.push({ id: Math.random().toString(36).slice(2, 9), n, layer, cover }));
  add('C', [['Acer saccharum', 5], ['Tilia americana', 3], ['Ulmus americana', 2]]);
  add('S', [['Ostrya virginiana', 3], ['Acer saccharum', 3]]);
  add('H', [['Acer saccharum', 2]]);
  add('G', [['Hydrophyllum virginianum', 3], ['Caulophyllum thalictroides', 2], ['Sanguinaria canadensis', 1], ['Arisaema triphyllum', 1],
    ['Carex pedunculata', 1], ['Dicentra cucullaria', 1], ['Allium tricoccum', 2], ['Osmorhiza claytonii', 1], ['Maianthemum racemosum', 1],
    ['Asarum canadense', 1], ['Erythronium albidum', 2], ['Galium aparine', 1], ['Anemone acutiloba', 1], ['Viola pubescens', 1]]);
  return p;
}

// ---------------------------------------------------------------- start
(async () => {
  const stored = await dbGet('state').catch(() => null);
  if (stored) S = { ...S, ...stored };
  if (!S.plot) { S.plot = examplePlot(S.settings); S.tab = 'results'; }
  S.plot.layerCover ||= { C: '', S: '', H: '', G: '' };                       // plots saved by v0.1
  S.plot.muni ??= ''; S.plot.trs ??= '';                                       // plots saved before v0.6
  D = await fetch('data/npc-data.json').then(r => r.json());
  fetch('data/ecs.json').then(r => r.json()).then(e => { ECS = e; const b = $('#ecsBox'); if (b) b.innerHTML = ecsLine(); refreshPalette(); }).catch(() => {});
  fetch('data/dist.json').then(r => r.json()).then(d => { DIST = d; refreshPalette(); }).catch(() => {});
  buildSearch(); render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
