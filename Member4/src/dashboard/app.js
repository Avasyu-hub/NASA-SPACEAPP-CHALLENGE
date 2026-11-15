// LunaWise app shell (M3): dashboard + whole-Moon globe + M4's lander digital twin, one store.
// Rule 1 (WORKPLAN section 0): every number shown comes from data_out/ or missionLogic.js.
import { store, readHash, writeHash } from '../store.js';
import {
  evaluate, delayScan, firstFailingDelay, rankSites, failureMessage, batteryTrace, fmtTime, hourIndexOf,
} from '../../../web/src/core/missionLogic.js';
import { horizonAt } from '../../../Member2/src/raycast.js';
import { loadSites, loadResults, loadAngles, loadMask, loadFarHeightmap } from './data.js';
import { MoonGlobe } from './MoonGlobe.js';
import { Timeline } from './timeline.js';
import validation from '../../../docs/validation/goddard_terrain.json';

const $ = (id) => document.getElementById(id);
const app = $('app');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shortName = (s) => (s ? s.name.replace(/\s*\(PGDA Site\d+\)/, '') : '—');
const fmtLat = (v) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'W' : 'E'}`;
const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const signed = (v, d = 1) => (v == null || !Number.isFinite(v) ? '' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`);

const D = { sites: [], results: {}, angles: {}, masks: {}, ready: false };
let cur = null;         // evaluation of the selected site
let fromSim = false;    // a store update that came from the 3D view
let sim = null, simReady = null, globe = null, timeline = null;

// ---------------------------------------------------------------- data
function siteById(id) { return D.sites.find((s) => s.id === id); }
function opts(s, delayDays = s.delayDays) {
  return { startDate: s.startDate, delayDays, durationDays: s.durationDays };
}
function reqs(s) { return { ...s.requirements, battery: { ...s.lander } }; }
function profile(id) {
  const m = D.masks[id];
  return m ? (m.elev_deg_by_mast?.['2'] ?? m.elev_deg) : null;
}
function horizonFn(id) {
  const m = D.masks[id], p = profile(id);
  if (!p) return null;
  const step = m.elev_deg_by_mast ? 360 / p.length : m.az_step_deg;
  return (az) => horizonAt(p, az, step);
}

// ---------------------------------------------------------------- evaluation
function evaluateSelected(s) {
  const r = D.results[s.siteId];
  if (!r) return null;
  const ev = evaluate(r, opts(s), reqs(s));
  const nominal = evaluate(r, opts(s, 0), reqs(s));
  const battery = ev.window.hours ? batteryTrace(r, ev.window, s.lander) : null;
  return { ev, nominal, battery, results: r };
}

const calCache = new Map();
function calendarFor(id, s) {
  const key = `${id}|${s.durationDays}|${JSON.stringify(s.requirements)}|${JSON.stringify(s.lander)}`;
  if (calCache.has(key)) return calCache.get(key);
  const r = D.results[id];
  const days = Math.floor(r.t.length / 24);
  const out = new Array(days);
  for (let d = 0; d < days; d++) {
    const e = evaluate(r, { startDate: r.t[d * 24], delayDays: 0, durationDays: s.durationDays }, reqs(s));
    out[d] = e.window.truncated ? 'na' : e.pass ? 'pass' : 'fail';
  }
  calCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- rendering: mission tab
function renderSiteHead(s) {
  const site = siteById(s.siteId);
  $('site-title').textContent = shortName(site).toUpperCase();
  $('site-meta').textContent = site
    ? `${site.id.toUpperCase()} · ${fmtLat(site.lat)} ${fmtLon(site.lon)} · ${Math.round(site.ground_height_m)} m · ${site.obs_height_m} m mast`
    : '—';
  $('site-select').value = s.siteId;
}

function renderVerdict(s) {
  const v = $('verdict');
  if (!cur) { v.dataset.state = 'na'; return; }
  const { ev } = cur;
  const site = siteById(s.siteId);
  const name = site ? site.name : s.siteId;
  const btn = $('btn-show-3d');
  if (ev.window.truncated || !ev.window.hours) {
    v.dataset.state = 'na';
    $('verdict-word').textContent = 'NO DATA';
    $('verdict-sub').textContent = 'outside 2027';
    $('verdict-text').textContent = 'This window runs past the computed data (2027). Pick an earlier landing date or a shorter slip.';
    btn.hidden = true;
    return;
  }
  v.dataset.state = ev.pass ? 'pass' : 'fail';
  $('verdict-word').textContent = ev.pass ? 'GO' : 'NO GO';
  $('verdict-sub').textContent = ev.pass
    ? `all requirements met${s.delayDays ? ` with a ${s.delayDays}-day slip` : ''}`
    : `${ev.failure.kind === 'comm' ? 'comm gap' : ev.failure.kind === 'night' ? 'night too long'
        : ev.failure.kind === 'battery' ? 'battery empty' : 'below target'} · mission hour ${ev.failure.missionHour + 1}`;
  $('verdict-text').textContent = failureMessage(ev.failure, name);
  btn.hidden = ev.pass;
}

function renderControls(s) {
  $('in-start').value = s.startDate.slice(0, 10);
  $('in-delay').value = s.delayDays;
  $('out-delay').textContent = `+${s.delayDays} d`;
  $('in-dur').value = s.durationDays;
  $('in-minsun').value = s.requirements.minSunPct;
  $('in-night').value = s.requirements.maxNightH;
  $('in-gap').value = s.requirements.maxCommGapH;
  $('in-cap').value = s.lander.capacityWh;
  $('in-solar').value = s.lander.solarW;
  $('in-load').value = s.lander.loadW;
  $('req-summary').textContent =
    `≥ ${s.requirements.minSunPct}% sun · night ≤ ${s.requirements.maxNightH} h · gap ≤ ${s.requirements.maxCommGapH} h`;
  const w = cur?.ev.window;
  $('slip-land').textContent = w && w.startT
    ? `lands ${fmtTime(w.startT)}, mission ends ${fmtTime(w.endT)}`
    : 'window runs past the computed data';
}

function metric(label, value, unit, delta, deltaGood, sub = '') {
  let d = '';
  if (delta) d = `<span class="delta ${deltaGood ? 'good' : 'bad'}">${delta}</span>`;
  return `<div class="metric"><span class="micro">${label}</span><b>${value}<small>${unit}</small></b>${d}<span class="msub">${sub}</span></div>`;
}

function renderMetrics(s) {
  const el = $('metrics');
  if (!cur || !cur.ev.window.hours) { el.innerHTML = ''; $('metrics-note').textContent = '—'; return; }
  const m = cur.ev.metrics, n = cur.nominal.metrics;
  const slip = s.delayDays > 0 && cur.nominal.window.hours;
  const dp = (a, b) => (slip ? signed(a - b) : '');
  const dh = (a, b) => (slip && a !== b ? signed(a - b, 0) : '');
  const at = (iso) => (iso ? `from ${iso.slice(5, 10)} ${iso.slice(11, 16)}` : '');
  el.innerHTML = [
    metric('Sunlit', num(m.sunPct), '%', dp(m.sunPct, n.sunPct), m.sunPct >= n.sunPct),
    metric('Earth in view', num(m.earthPct), '%', dp(m.earthPct, n.earthPct), m.earthPct >= n.earthPct),
    metric('Both', num(m.bothPct), '%', dp(m.bothPct, n.bothPct), m.bothPct >= n.bothPct),
    metric('Longest night', m.longestNightH, 'h', dh(m.longestNightH, n.longestNightH),
      m.longestNightH <= n.longestNightH, at(m.longestNightStart)),
    metric('Longest comm gap', m.longestCommGapH, 'h', dh(m.longestCommGapH, n.longestCommGapH),
      m.longestCommGapH <= n.longestCommGapH, at(m.longestCommGapStart)),
    metric('Battery low point', cur.battery ? Math.round(cur.battery.minWh) : '—', 'Wh', '', true, 'scenario model'),
  ].join('');
  $('metrics-note').textContent = slip
    ? `${m.hours} h window. Changes are against landing on time (${cur.nominal.window.startT.slice(0, 10)}).`
    : `${m.hours} h window, hourly flags at a 2 m mast.`;
}

function nextChange(arr, h) {
  for (let k = h + 1; k < arr.length; k++) if (arr[k] !== arr[h]) return k - h;
  return null;
}

function renderNow(s) {
  const el = $('now');
  const r = D.results[s.siteId], a = D.angles[s.siteId], H = horizonFn(s.siteId);
  const h = s.currentHour;
  if (!r || !a || h == null || !r.t[h]) { el.innerHTML = ''; $('now-time').textContent = '—'; return; }
  $('now-time').textContent = fmtTime(r.t[h]);
  const sunUp = r.sun_lit[h] === 1, earthUp = r.earth_vis[h] === 1;
  const ds = nextChange(r.sun_lit, h), de = nextChange(r.earth_vis, h);
  const sunMargin = H ? a.sun_el[h] - H(a.sun_az[h]) : null;
  const earthMargin = H ? a.earth_el[h] - H(a.earth_az[h]) : null;
  let maxEl = null;
  const w = cur?.ev.window;
  if (w && w.hours) { maxEl = -Infinity; for (let k = w.startIdx; k < w.endIdx; k++) maxEl = Math.max(maxEl, a.sun_el[k]); }
  el.innerHTML = `
    <div class="now-big">
      <span class="micro">Solar elevation</span>
      <b>${num(a.sun_el[h], 2)}<small>°</small></b>
      <span class="msub">${sunMargin == null ? '' : `${num(Math.abs(sunMargin), 2)}° ${sunMargin >= 0 ? 'above' : 'below'} the ridge`}${maxEl != null ? ` · highest in window ${num(maxEl, 2)}°` : ''}</span>
    </div>
    <div class="now-row ${sunUp ? 'up' : 'down'}"><i class="sun"></i><span>${sunUp ? 'Sun up' : 'Sun down'}</span>
      <em>${ds == null ? '—' : `${sunUp ? 'sunset' : 'sunrise'} in ${ds} h`}</em></div>
    <div class="now-row ${earthUp ? 'up' : 'down'}"><i class="earth"></i><span>${earthUp ? 'Earth in view' : 'Earth hidden'}</span>
      <em>${de == null ? '—' : `${earthUp ? 'earthset' : 'earthrise'} in ${de} h`}${earthMargin == null ? '' : ` · ${signed(earthMargin, 2)}° vs ridge`}</em></div>`;
}

function renderSkyline(s) {
  const svg = $('skyline');
  const a = D.angles[s.siteId], p = profile(s.siteId), r = D.results[s.siteId];
  const w = cur?.ev.window, h = s.currentHour;
  if (!a || !p || !w || !w.hours) { svg.innerHTML = ''; return; }
  let lo = Math.min(...p), hi = Math.max(...p);
  for (let k = w.startIdx; k < w.endIdx; k++) {
    lo = Math.min(lo, a.sun_el[k], a.earth_el[k]); hi = Math.max(hi, a.sun_el[k], a.earth_el[k]);
  }
  lo = Math.floor(lo - 0.5); hi = Math.ceil(hi + 0.5);
  const Y = (el) => 120 - ((el - lo) / (hi - lo)) * 120;
  const step = 360 / p.length;
  let d = `M0,120`;
  p.forEach((v, i) => { d += ` L${(i * step).toFixed(2)},${Y(v).toFixed(2)}`; });
  d += ` L360,${Y(p[0]).toFixed(2)} L360,120 Z`;
  const dots = (azK, elK, color) => {
    let out = '';
    for (let k = w.startIdx; k < w.endIdx; k += 2) out += `<circle cx="${a[azK][k].toFixed(2)}" cy="${Y(a[elK][k]).toFixed(2)}" r="0.9" fill="${color}"/>`;
    return out;
  };
  const grid = [];
  for (let e = Math.ceil(lo); e <= hi; e++) {
    grid.push(`<line x1="0" x2="360" y1="${Y(e)}" y2="${Y(e)}" class="${e === 0 ? 'g0' : 'g'}"/>`);
    if (e % 2 === 0) grid.push(`<text x="2" y="${Y(e) - 1.5}" class="gt">${e}°</text>`);
  }
  const azLbl = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, x]) =>
    `<text x="${x + 2}" y="118" class="gt">${t}</text><line x1="${x}" x2="${x}" y1="0" y2="120" class="g"/>`).join('');
  let nowMarks = '';
  if (h != null && a.sun_az[h] != null) {
    const sunC = r.sun_lit[h] ? '#FFD58A' : '#FF5A4F', earC = r.earth_vis[h] ? '#5B8EF0' : '#FF5A4F';
    nowMarks = `<circle cx="${a.sun_az[h]}" cy="${Y(a.sun_el[h])}" r="3.4" class="now-ring" stroke="${sunC}"/>` +
      `<circle cx="${a.earth_az[h]}" cy="${Y(a.earth_el[h])}" r="4.2" class="now-ring" stroke="${earC}"/>`;
  }
  svg.innerHTML = `${grid.join('')}${azLbl}<path d="${d}" class="terrain"/>${dots('sun_az', 'sun_el', '#FFD58A')}${dots('earth_az', 'earth_el', '#5B8EF0')}${nowMarks}`;
}

// ---------------------------------------------------------------- rendering: compare tab
function renderCompare(s) {
  if (!D.ready) return;
  const list = D.sites.filter((x) => D.results[x.id]).map((x) => ({ name: x.name, results: D.results[x.id] }));
  const rk = rankSites(list, opts(s), reqs(s), s.sortBy);
  const row = (e, pass) => {
    const id = e.site;
    const f = e.failure;
    const why = pass ? '—' : f ? `${f.kind} · h${f.missionHour + 1}` : 'past 2027';
    return `<tr data-site="${id}" class="${id === s.siteId ? 'is-sel' : ''}">
      <td><span class="st ${pass ? 'pass' : e.window.truncated ? 'na' : 'fail'}"></span>${esc(shortName(siteById(id)))}<small>${id.toUpperCase()}</small></td>
      <td class="n">${num(e.metrics.sunPct)}</td><td class="n">${num(e.metrics.earthPct)}</td><td class="n">${num(e.metrics.bothPct)}</td>
      <td class="n">${e.metrics.longestNightH}</td><td class="n">${e.metrics.longestCommGapH}</td><td class="why">${why}</td></tr>`;
  };
  $('rank').innerHTML = `<thead><tr><th>Site</th><th>Sun %</th><th>Earth %</th><th>Both %</th><th>Night h</th><th>Gap h</th><th>First failure</th></tr></thead>
    <tbody>${rk.passing.map((e) => row(e, true)).join('')}${rk.failing.map((e) => row(e, false)).join('')}</tbody>`;
  $('rank-note').textContent = `${rk.passing.length} of ${list.length} candidate sites meet every requirement with a ${s.delayDays}-day slip. Passing sites first, sorted by one metric; no combined score.`;

  // Delay-tolerance strip
  $('strip').innerHTML = D.sites.filter((x) => D.results[x.id]).map((site) => {
    const scan = delayScan(D.results[site.id], opts(s, 0), reqs(s), 30);
    const fd = firstFailingDelay(scan);
    const ok = scan[0].pass;
    const lab = !ok ? 'fails on time' : fd === null ? 'passes every slip to 30 d' : fd === 1 ? 'no slip margin past on-time' : `takes up to ${fd - 1} d of slip`;
    const cells = scan.map((x) => {
      const st = x.window.truncated ? 'na' : x.pass ? 'pass' : 'fail';
      const sel = site.id === s.siteId && x.delayDays === s.delayDays ? ' is-sel' : '';
      return `<button type="button" class="sq ${st}${sel}" data-site="${site.id}" data-delay="${x.delayDays}" title="${esc(shortName(site))}: +${x.delayDays} d, ${st === 'pass' ? 'meets requirements' : st === 'na' ? 'past 2027' : x.failure?.kind || 'fails'}"></button>`;
    }).join('');
    return `<div class="strip-row ${site.id === s.siteId ? 'is-sel' : ''}"><div class="strip-name"><b>${esc(shortName(site))}</b><small>${lab}</small></div><div class="strip-cells">${cells}</div></div>`;
  }).join('') + `<div class="strip-axis"><span>+0</span><span>+10</span><span>+20</span><span>+30 d</span></div>`;

  // Calendar heatmap
  const r0 = D.results[D.sites[0].id];
  const startIdx = hourIndexOf(r0.t, s.startDate);
  const months = [];
  for (let d = 0; d < Math.floor(r0.t.length / 24); d++) {
    const t = r0.t[d * 24];
    if (t.slice(8, 10) === '01') months.push({ d, label: new Date(t).toLocaleString('en', { month: 'short', timeZone: 'UTC' }) });
  }
  const nDays = Math.floor(r0.t.length / 24);
  $('cal').innerHTML = D.sites.filter((x) => D.results[x.id]).map((site) => {
    const c = calendarFor(site.id, s);
    const good = c.filter((x) => x === 'pass').length;
    const cells = c.map((st, d) => `<i class="${st}${site.id === s.siteId && d === Math.floor(startIdx / 24) ? ' is-sel' : ''}" data-site="${site.id}" data-day="${d}"></i>`).join('');
    return `<div class="cal-row"><div class="cal-name"><b>${esc(shortName(site))}</b><small>${good} of ${c.filter((x) => x !== 'na').length} days</small></div><div class="cal-cells" style="--n:${nDays}">${cells}</div></div>`;
  }).join('') + `<div class="cal-axis" style="--n:${nDays}">${months.map((m) => `<span style="--d:${m.d}">${m.label}</span>`).join('')}</div>`;
}

function renderValidation() {
  const rows = validation.map((v) => `<tr><td>${esc(v.name.replace(/\s*\(PGDA Site\d+\)/, ''))}<small>${esc(v.site.toUpperCase())}</small></td>
    <td class="n">${num(v.goddard_sun_pct)}</td><td class="n">${num(v.ours_sun_pct_0m)}</td><td class="n d">${signed(v.diff_sun_0m)}</td>
    <td class="n">${num(v.goddard_earth_pct)}</td><td class="n">${num(v.ours_earth_pct_0m)}</td><td class="n d">${signed(v.diff_earth_0m)}</td></tr>`).join('');
  $('valid').innerHTML = `<thead><tr><th rowspan="2">Site</th><th colspan="3">Sun %</th><th colspan="3">Earth %</th></tr>
    <tr><th>NASA</th><th>ours</th><th>diff</th><th>NASA</th><th>ours</th><th>diff</th></tr></thead><tbody>${rows}</tbody>`;
}

// ---------------------------------------------------------------- timeline + clock
function renderTimeline(s) {
  if (!timeline || !cur || !cur.ev.window.hours) return;
  const H = horizonFn(s.siteId);
  timeline.set({
    results: cur.results, angles: D.angles[s.siteId], horizonAt: H,
    win: cur.ev.window, nominal: cur.nominal.window.hours ? cur.nominal.window : cur.ev.window,
    battery: cur.battery, failure: cur.ev.failure, cursor: s.currentHour, delayDays: s.delayDays,
  });
}

function renderClock(s) {
  const r = D.results[s.siteId], a = D.angles[s.siteId], h = s.currentHour;
  if (!r || h == null || !r.t[h]) return;
  $('clock-time').textContent = fmtTime(r.t[h]);
  const w = cur?.ev.window;
  $('clock-mh').textContent = w && h >= w.startIdx && h < w.endIdx
    ? `mission hour ${h - w.startIdx + 1} of ${w.hours}` : 'outside the mission window';
  $('ephem').innerHTML = a
    ? `<span>SUN <b>${num(a.sun_az[h])}°</b> az <b>${num(a.sun_el[h], 2)}°</b> el</span><span>EARTH <b>${num(a.earth_az[h])}°</b> az <b>${num(a.earth_el[h], 2)}°</b> el</span>`
    : '—';
  $('b-play').textContent = s.isPlaying ? '❚❚' : '▶';
  $('b-play').setAttribute('aria-label', s.isPlaying ? 'Pause' : 'Play');
}

function updateGlobeSky(s) {
  const a = D.angles[s.siteId], r = D.results[s.siteId], h = s.currentHour;
  if (!globe || !a || !r || h == null || a.sun_az[h] == null) return;
  globe.setSky(s.siteId, {
    sunAz: a.sun_az[h], sunEl: a.sun_el[h], earthAz: a.earth_az[h], earthEl: a.earth_el[h],
    sunLit: r.sun_lit[h] === 1, earthVis: r.earth_vis[h] === 1,
  });
}

function updateGlobeStatus(s) {
  if (!globe || !D.ready) return;
  const st = {};
  for (const site of D.sites) {
    const r = D.results[site.id];
    if (!r) continue;
    const e = evaluate(r, opts(s), reqs(s));
    st[site.id] = e.window.truncated ? 'na' : e.pass ? 'pass' : 'fail';
  }
  globe.setStatus(st);
}

// ---------------------------------------------------------------- 3D digital twin (M4)
async function ensureSim() {
  if (sim) return simReady;
  const { LanderSimulation } = await import('../simulation/LanderSimulation.js');
  const first = store.get().siteId;
  // Serialise loads (the constructor starts one) and start on the selected site.
  class AppSim extends LanderSimulation {
    loadDataset(id) {
      const target = this._started ? id : first;
      this._started = true;
      this._chain = (this._chain || Promise.resolve()).then(() => super.loadDataset(target));
      return this._chain;
    }
  }
  const container = $('stage-sim');
  container.hidden = false;
  let lastPlay = false;
  sim = new AppSim(container, (t) => {
    // The twin's own Space key toggles its player; hand playback to the app's player instead.
    if (sim && sim.isPlaying !== lastPlay) {
      lastPlay = sim.isPlaying;
      if (sim.isPlaying) { sim.isPlaying = false; lastPlay = false; togglePlay(); }
    }
    onSimTelemetry(t);
  }, (loading, msg) => setLoading(loading, msg));
  const s = store.get();
  pushMissionToSim(s, false);
  // Skip drawing while the Moon view is showing.
  const render = sim.renderer.render.bind(sim.renderer);
  sim.renderer.render = (scene, cam) => { if (store.get().view !== 'moon') render(scene, cam); };
  simReady = sim._chain.then(() => sim);
  return simReady;
}

function pushMissionToSim(s, apply = true) {
  if (!sim) return;
  sim.mission = { nominalLandingDate: s.startDate, delayDays: s.delayDays, durationDays: s.durationDays };
  sim.requirements = reqs(s);
  if (!apply) return;
  if (sim.currentSiteId !== s.siteId) {
    sim.loadDataset(s.siteId).then(() => { if (s.currentHour != null) sim.setHourIndex(store.get().currentHour); });
  } else if (sim.dataset) {
    sim.evaluateMission();
    sim.setHourIndex(s.currentHour ?? sim.dataset.window.startIdx);
  }
}

function onSimTelemetry(t) {
  // HUD
  const hud = (id, ok, okText, badText, ray) => {
    const el = $(id);
    el.dataset.state = ok ? 'up' : 'down';
    el.querySelector('b').textContent = ok ? okText : badText;
    el.querySelector('small').textContent = `ray-cast: ${ray ? 'clear' : 'blocked'}`;
  };
  hud('hud-sun', t.sunLitEngine, 'above terrain', 'below terrain', t.sunLitRaycast);
  hud('hud-earth', t.earthVisEngine, 'in view', 'behind terrain', t.earthVisRaycast);
  const ag = t.agreement;
  const fmt = (r) => (!r ? 'computing…' : r.error ? 'error' : `${r.pct.toFixed(1)}% of ${r.checked} h`);
  $('hud-ray').textContent = ag && (ag.sun || ag.earth)
    ? `agrees with engine · Sun ${fmt(ag.sun)} · Earth ${fmt(ag.earth)}`
    : t.isRealData ? 'checking every hour of 2027…' : '—';
  $('t-sun').classList.toggle('is-on', t.trackingTarget === 'sun');
  $('t-earth').classList.toggle('is-on', t.trackingTarget === 'earth');
  const walk = $('hud-walk');
  walk.hidden = !(t.walkDistM > 50);
  if (!walk.hidden) walk.textContent = `The horizon line is for the lander position; you are ${t.walkDistM} m away.`;
  if (t.siteId === store.get().siteId && t.hourIndex !== store.get().currentHour) {
    fromSim = true;
    store.set({ currentHour: t.hourIndex });
    fromSim = false;
  }
}

// ---------------------------------------------------------------- playback (one player for all views)
let playAcc = 0, playLast = 0;
function togglePlay() { store.set({ isPlaying: !store.get().isPlaying }); }
function playLoop(now) {
  requestAnimationFrame(playLoop);
  const s = store.get();
  if (!s.isPlaying || !cur || !cur.ev.window.hours) { playLast = now; return; }
  const dt = Math.min(0.5, (now - playLast) / 1000);
  playLast = now;
  playAcc += dt * s.speed;
  if (playAcc < 1) return;
  const step = Math.floor(playAcc);
  playAcc -= step;
  const w = cur.ev.window;
  let h = (s.currentHour ?? w.startIdx) + step;
  if (h >= w.endIdx || h < w.startIdx) h = w.startIdx;
  setHour(h);
}
function setHour(h) { store.set({ currentHour: h }); }

// ---------------------------------------------------------------- views
async function setView(view) {
  store.set({ view });
}
async function applyView(s) {
  app.dataset.view = s.view;
  document.querySelectorAll('.views button').forEach((b) => b.classList.toggle('is-on', b.dataset.view === s.view));
  const moon = s.view === 'moon';
  globe?.setVisible(moon);
  $('hud').hidden = moon;
  $('legend').hidden = !moon;
  if (moon) { $('stage-sim').hidden = true; return; }
  await ensureSim();
  $('stage-sim').hidden = false;
  sim.setViewMode(s.view === 'overview' ? 'overview' : 'lander');
  $('hud-keys').textContent = s.view === 'overview'
    ? 'Drag to orbit · scroll to zoom · W A S D to pan'
    : 'Drag to look · W A S D to walk · double-click to track the Sun / Earth';
  sim.onResize();
  pushMissionToSim(store.get());
}

// ---------------------------------------------------------------- render orchestration
function renderAll(s) {
  cur = evaluateSelected(s);
  renderSiteHead(s);
  renderVerdict(s);
  renderControls(s);
  renderMetrics(s);
  renderNow(s);
  renderSkyline(s);
  renderTimeline(s);
  renderClock(s);
  renderCompare(s);
  updateGlobeStatus(s);
  updateGlobeSky(s);
}

function renderTick(s) {
  renderNow(s);
  renderSkyline(s);
  timeline?.setCursor(s.currentHour);
  renderClock(s);
  updateGlobeSky(s);
}

const SCENARIO_KEYS = ['siteId', 'startDate', 'delayDays', 'durationDays', 'requirements', 'lander'];

async function onChange(s, patch) {
  const keys = Object.keys(patch);
  if (keys.includes('siteId')) await ensureSiteData(s.siteId);
  if (keys.some((k) => SCENARIO_KEYS.includes(k))) {
    // A new scenario starts at the landing hour, like the 3D view does (setDelayDays).
    const e = D.results[s.siteId] && evaluate(D.results[s.siteId], opts(s), reqs(s));
    if (e && e.window.hours && !keys.includes('currentHour')) {
      Object.assign(s, { currentHour: e.window.startIdx });
    }
    renderAll(s);
    if (keys.includes('siteId')) { globe?.select(s.siteId, { fly: s.view === 'moon' }); }
    if (!fromSim) pushMissionToSim(s);
    writeHash(s);
    return;
  }
  if (keys.includes('view')) { await applyView(s); writeHash(s); }
  if (keys.includes('tab')) applyTab(s);
  if (keys.includes('sortBy')) renderCompare(s);
  if (keys.includes('currentHour')) {
    renderTick(s);
    if (!fromSim && sim?.dataset && sim.currentSiteId === s.siteId) sim.setHourIndex(s.currentHour);
  }
  if (keys.includes('isPlaying')) renderClock(s);
}

function applyTab(s) {
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === s.tab)));
  document.querySelectorAll('.tabpane').forEach((p) => { p.hidden = p.dataset.pane !== s.tab; });
}

async function ensureSiteData(id) {
  const tasks = [];
  if (!D.results[id]) tasks.push(loadResults(id).then((r) => { D.results[id] = r; }));
  if (!D.angles[id]) tasks.push(loadAngles(id).then((a) => { D.angles[id] = a; }));
  if (!D.masks[id]) tasks.push(loadMask(id).then((m) => { D.masks[id] = m; }));
  try { await Promise.all(tasks); } catch (e) { toast(`Data not found for ${id}. ${e.message}`); }
}

// ---------------------------------------------------------------- UI wiring
function setLoading(on, msg) {
  $('loading').classList.toggle('is-on', !!on);
  if (msg) $('loading-text').textContent = msg;
}
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5200);
}

function wire() {
  const s = () => store.get();
  $('site-select').addEventListener('change', (e) => store.set({ siteId: e.target.value }));
  $('in-start').addEventListener('change', (e) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) store.set({ startDate: `${e.target.value}T00:00:00Z` });
  });
  $('in-delay').addEventListener('input', (e) => store.set({ delayDays: Number(e.target.value) }));
  $('in-dur').addEventListener('change', (e) => {
    const v = Math.max(1, Math.min(30, Math.round(Number(e.target.value) || 14)));
    store.set({ durationDays: v });
  });
  const reqInput = (id, key, lo, hi) => $(id).addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < lo || v > hi) { renderControls(s()); return; }
    store.set({ requirements: { ...s().requirements, [key]: v } });
  });
  reqInput('in-minsun', 'minSunPct', 0, 100);
  reqInput('in-night', 'maxNightH', 0, 720);
  reqInput('in-gap', 'maxCommGapH', 0, 720);
  const batInput = (id, key) => $(id).addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) { renderControls(s()); return; }
    store.set({ lander: { ...s().lander, [key]: v } });
  });
  batInput('in-cap', 'capacityWh'); batInput('in-solar', 'solarW'); batInput('in-load', 'loadW');

  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => store.set({ tab: b.dataset.tab })));
  document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('home-link').addEventListener('click', (e) => { e.preventDefault(); store.set({ view: 'moon' }); globe?.flyHome(); });
  $('sort-by').addEventListener('change', (e) => store.set({ sortBy: e.target.value }));

  $('rank').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-site]');
    if (tr) store.set({ siteId: tr.dataset.site });
  });
  $('strip').addEventListener('click', (e) => {
    const b = e.target.closest('.sq');
    if (b) store.set({ siteId: b.dataset.site, delayDays: Number(b.dataset.delay) });
  });
  $('cal').addEventListener('click', (e) => {
    const c = e.target.closest('i[data-day]');
    if (!c) return;
    const r = D.results[c.dataset.site];
    store.set({ siteId: c.dataset.site, startDate: r.t[Number(c.dataset.day) * 24], delayDays: 0 });
  });

  $('btn-show-3d').addEventListener('click', async () => {
    const f = cur?.ev.failure;
    if (!f) return;
    if (s().view === 'moon') store.set({ view: 'lander' });
    await ensureSim();
    await sim._chain;
    pushMissionToSim(s());
    sim.jumpToFirstFailure();
  });

  // Transport
  $('b-play').addEventListener('click', togglePlay);
  $('b-back').addEventListener('click', () => setHour(Math.max(0, (s().currentHour ?? 0) - 1)));
  $('b-fwd').addEventListener('click', () => setHour((s().currentHour ?? 0) + 1));
  $('b-start').addEventListener('click', () => cur && setHour(cur.ev.window.startIdx));
  $('b-speed').addEventListener('change', (e) => store.set({ speed: Number(e.target.value) }));
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) return;
    // In the 3D views the twin handles Space itself (and hands it to togglePlay above).
    if (e.code === 'Space' && s().view === 'moon') { e.preventDefault(); togglePlay(); }
  });

  // 3D tools
  $('t-sun').addEventListener('click', () => sim?.setTrackingTarget('sun'));
  $('t-earth').addEventListener('click', () => sim?.setTrackingTarget('earth'));
  $('t-north').addEventListener('click', () => sim?.lookNorth());
  $('t-fail').addEventListener('click', () => { if (sim?.dataset?.firstFailure) sim.jumpToFirstFailure(); else toast('No failure in this window.'); });
  let mask = true, slope = false, scaleI = 0;
  $('t-mask').addEventListener('click', (e) => { mask = !mask; sim?.horizon.setVisible(mask); e.currentTarget.classList.toggle('is-on', mask); });
  $('t-slope').addEventListener('click', (e) => { slope = !slope; sim?.terrain.setOverlay(slope ? 'slope' : 'none'); e.currentTarget.classList.toggle('is-on', slope); });
  $('t-scale').addEventListener('click', (e) => {
    const steps = [1, 3, 5];
    scaleI = (scaleI + 1) % steps.length;
    sim?.celestials.setExaggeration(steps[scaleI]);
    e.currentTarget.textContent = `Size ×${steps[scaleI]}`;
    e.currentTarget.classList.toggle('is-on', scaleI > 0);
    $('hud-scale-note').hidden = scaleI === 0;
  });

  $('btn-share').addEventListener('click', async () => {
    writeHash(s());
    let framed = false;
    try { framed = window.self !== window.top; } catch { framed = true; }
    if (framed) { toast('Scenario links work on the deployed site. This embedded preview cannot share them.'); return; }
    try { await navigator.clipboard.writeText(window.location.href); toast('Link copied. It opens this exact scenario.'); }
    catch { toast('Copying was blocked by the browser. The address bar holds this scenario.'); }
  });
}

// ---------------------------------------------------------------- boot
async function boot() {
  wire();
  renderValidation();
  store.set({ ...readHash() });
  store.subscribe((s, patch) => { onChange(s, patch); });
  applyTab(store.get());

  timeline = new Timeline($('timeline'), $('tl-tip'), { onScrub: (h) => setHour(h) });
  globe = new MoonGlobe($('stage-globe'), { onSelect: (id) => store.set({ siteId: id }) });

  try {
    D.sites = await loadSites();
  } catch (e) {
    setLoading(true, 'Data not found: data_out/ was not copied into ./data. Run npm run sync-data.');
    return;
  }
  if (!siteById(store.get().siteId)) store.get().siteId = D.sites[0].id;
  $('site-select').innerHTML = D.sites.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  globe.setSites(D.sites);

  await Promise.all(D.sites.map((x) => loadResults(x.id).then((r) => { D.results[x.id] = r; }).catch(() => {})));
  await ensureSiteData(store.get().siteId);
  D.ready = true;
  setLoading(false);

  const s = store.get();
  const e = evaluate(D.results[s.siteId], opts(s), reqs(s));
  s.currentHour = e.window.hours ? e.window.startIdx : 0;
  renderAll(s);
  globe.select(s.siteId, { fly: false });
  await applyView(s);
  if (s.view === 'moon') setTimeout(() => globe.flyToSite(s.siteId, 0.11), 600);
  requestAnimationFrame(playLoop);

  // Terrain tiles for the globe, one site at a time (about 1 MB each).
  for (const site of D.sites) {
    try {
      const { meta, far } = await loadFarHeightmap(site.id);
      globe.addTerrainTile(site.id, meta, far);
    } catch { /* tile missing: the photo map shows through */ }
  }
}

boot();
