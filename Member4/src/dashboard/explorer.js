// LunaWise: 2D South Pole map + Expedition planner (added on top of the dashboard; app.js unchanged).
//
// Brings back the two features of the earlier M4 UI (twin.html), rebuilt on the backend data:
//   - South Pole map: polar stereographic map of the 5 candidate sites and M2's 20 computed nearby
//     points (data_out/nearby.json), over shaded relief made from our own LOLA heightmaps.
//     A click snaps to the nearest COMPUTED point (<= SNAP_M). Anywhere else the map says "not
//     computed here" and shows no Sun/Earth numbers (README rule 4; replaces computeCustomEphemeris()).
//   - Expedition planner: any date range in 2027 for any computed point, evaluated with M1's
//     missionLogic.js using the requirements and battery set in the Mission tab.
// Every number shown comes from data_out/ or missionLogic.js.
import './explorer.css';
import { store } from '../store.js';
import {
  evaluate, failureMessage, batteryTrace, countdowns, countdownText, fmtTime,
} from '../../../web/src/core/missionLogic.js';
import { loadSites, loadResults, loadAngles, loadMask, loadFarHeightmap } from './data.js';
import { CelestialBodies } from '../simulation/CelestialBodies.js';
import { MoonGlobe } from './MoonGlobe.js';
import * as THREE from 'three';

const R = 1737400;                     // lunar reference sphere (m), same as the pipeline
const SNAP_M = 600;                    // a click within this distance of a computed point selects it
const DEG = Math.PI / 180;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const signed = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`);
const fmtLat = (v) => `${Math.abs(v).toFixed(4)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(4)}°${v < 0 ? 'W' : 'E'}`;
const shortName = (n) => String(n).replace(/\s*\(PGDA Site\d+\)/, '');
const reqs = (s) => ({ ...s.requirements, battery: { ...s.lander } });
const scenarioOpts = (s) => ({ startDate: s.startDate, delayDays: s.delayDays, durationDays: s.durationDays });

// ---------------------------------------------------------------- geometry (sphere, as the pipeline)
/** South polar stereographic, true at the pole (lon_0 = 0): metres. */
function toXY(lat, lon) {
  const rho = 2 * R * Math.tan(Math.PI / 4 + (lat * DEG) / 2);
  return [rho * Math.sin(lon * DEG), rho * Math.cos(lon * DEG)];
}
function fromXY(x, y) {
  const rho = Math.hypot(x, y);
  const lat = (2 * Math.atan(rho / (2 * R)) - Math.PI / 2) / DEG;
  const lon = rho < 1e-6 ? 0 : Math.atan2(x, y) / DEG;
  return [lat, lon];
}
/** Great-circle destination (bearing clockwise from north), same formula as horizon.destination(). */
function destination(lat, lon, azDeg, distM) {
  const d = distM / R, la = lat * DEG, lo = lon * DEG, az = azDeg * DEG;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(az));
  const lo2 = lo + Math.atan2(Math.sin(az) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 / DEG, (((lo2 / DEG) + 540) % 360) - 180];
}
/** Unit vectors of local east and north at a point, in map metres. */
function localAxes(lat, lon) {
  const p = toXY(lat, lon);
  const unit = (q) => { const dx = q[0] - p[0], dy = q[1] - p[1], n = Math.hypot(dx, dy); return [dx / n, dy / n]; };
  return { E: unit(toXY(...destination(lat, lon, 90, 1000))), N: unit(toXY(...destination(lat, lon, 0, 1000))) };
}

// ---------------------------------------------------------------- data
const D = { sites: [], nearby: [], points: [], byId: new Map(), results: new Map(), angles: new Map(), masks: new Map(), tiles: [] };

async function loadAll() {
  D.sites = await loadSites();
  try {
    const r = await fetch('./data/nearby.json');
    D.nearby = r.ok ? await r.json() : [];
  } catch { D.nearby = []; }
  D.points = [
    ...D.sites.map((s) => ({ ...s, kind: 'site' })),
    ...D.nearby.map((n) => ({ ...n, kind: 'nearby' })),
  ].map((p) => ({ ...p, xy: toXY(p.lat, p.lon) }));
  D.points.forEach((p) => D.byId.set(p.id, p));
  await Promise.all(D.points.map((p) => loadResults(p.id).then((r) => D.results.set(p.id, r)).catch(() => {})));
}
async function pointData(id) {
  if (!D.angles.has(id)) D.angles.set(id, await loadAngles(id));
  if (!D.masks.has(id)) D.masks.set(id, await loadMask(id));
  return { results: D.results.get(id), angles: D.angles.get(id), mask: D.masks.get(id) };
}
function statusFor(id, s) {
  const r = D.results.get(id);
  if (!r) return 'na';
  const e = evaluate(r, scenarioOpts(s), reqs(s));
  return e.window.truncated || !e.window.hours ? 'na' : e.pass ? 'pass' : 'fail';
}

/** Hillshade of a site's 61 km far heightmap (our LOLA data), as an offscreen canvas. */
function hillshade(meta, far) {
  const { nx, ny, cell_m: cell } = meta.far;
  const c = document.createElement('canvas');
  c.width = nx; c.height = ny;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(nx, ny);
  const half = (nx * cell) / 2;
  const z = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r++) {
    const nOff = (r + 0.5) * cell - half;
    for (let col = 0; col < nx; col++) {
      const eOff = (col + 0.5) * cell - half;
      const v = far[r * nx + col];
      z[r * nx + col] = Number.isFinite(v) ? v + (eOff * eOff + nOff * nOff) / (2 * R) : NaN; // undo the export's curvature
    }
  }
  // light from the upper left of the image (north-west), 30 deg up; heights exaggerated x2 for readability
  const L = [-0.5, 0.5, 0.707];
  for (let r = 0; r < ny; r++) {
    for (let col = 0; col < nx; col++) {
      const at = (rr, cc) => z[Math.min(ny - 1, Math.max(0, rr)) * nx + Math.min(nx - 1, Math.max(0, cc))];
      const dzdx = (at(r, col + 1) - at(r, col - 1)) / (2 * cell) * 2;
      const dzdy = (at(r + 1, col) - at(r - 1, col)) / (2 * cell) * 2;      // r grows northward
      const n = [-dzdx, -dzdy, 1], nl = Math.hypot(...n);
      let shade = (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / nl;
      const v = z[r * nx + col];
      const row = ny - 1 - r;                                                 // image row 0 = north edge
      const i = (row * nx + col) * 4;
      if (!Number.isFinite(v)) { img.data[i + 3] = 0; continue; }
      shade = Math.max(0, Math.min(1, shade));
      const g = Math.round(26 + 150 * shade);
      img.data[i] = g; img.data[i + 1] = g + 2; img.data[i + 2] = g + 8; img.data[i + 3] = 235;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------- map view
const M = { open: false, canvas: null, ctx: null, ox: 0, oy: 0, scale: 1, w: 0, h: 0, sel: null, miss: null, drag: null, ready: false };

function fit() {
  const xs = D.points.map((p) => p.xy[0]), ys = D.points.map((p) => p.xy[1]);
  const pad = 40000;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  M.ox = (minX + maxX) / 2; M.oy = (minY + maxY) / 2;
  M.scale = Math.min(M.w / (maxX - minX), M.h / (maxY - minY));
}
const toScreen = (x, y) => [M.w / 2 + (x - M.ox) * M.scale, M.h / 2 - (y - M.oy) * M.scale];
const toWorld = (sx, sy) => [M.ox + (sx - M.w / 2) / M.scale, M.oy - (sy - M.h / 2) / M.scale];

function resize() {
  if (!M.canvas) return;
  const box = M.canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const first = !M.w;
  M.w = box.width; M.h = box.height;
  M.canvas.width = Math.round(M.w * dpr); M.canvas.height = Math.round(M.h * dpr);
  M.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (first && D.points.length) fit();
  draw();
}

function draw() {
  const ctx = M.ctx;
  if (!ctx || !M.w) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, M.w, M.h);
  ctx.fillStyle = '#05070c';
  ctx.fillRect(0, 0, M.w, M.h);

  // relief tiles (our heightmaps, 61.44 km around each site)
  for (const t of D.tiles) {
    const { E, N } = t.axes, s = M.scale, cell = t.cell, h = t.half;
    const [px, py] = t.xy;
    const A = M.w / 2 + s * (px - M.ox - E[0] * h + N[0] * h);
    const B = M.h / 2 - s * (py - M.oy - E[1] * h + N[1] * h);
    ctx.setTransform(dpr * s * cell * E[0], -dpr * s * cell * E[1], -dpr * s * cell * N[0], dpr * s * cell * N[1], dpr * A, dpr * B);
    ctx.drawImage(t.canvas, 0, 0);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // graticule: latitude circles and longitude spokes
  ctx.lineWidth = 1;
  const [cx, cy] = toScreen(0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '10px "IBM Plex Mono", monospace';
  for (const lat of [-89.5, -89, -88, -87, -86, -85]) {
    const rho = toXY(lat, 0)[1] * M.scale;
    ctx.beginPath(); ctx.arc(cx, cy, rho, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillText(`${Math.abs(lat)}°S`, cx + 4, cy - rho - 3);
  }
  for (let lon = 0; lon < 360; lon += 30) {
    const [ex, ey] = toScreen(...toXY(-84.5, lon));
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
    const [lx, ly] = toScreen(...toXY(-84.8, lon));
    const label = lon === 0 ? '0° (Earth side)' : lon <= 180 ? `${lon}°E` : `${360 - lon}°W`;
    ctx.fillText(label, lx + 3, ly);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, 2 * Math.PI); ctx.fill();
  ctx.fillText('South Pole', cx + 6, cy + 12);

  // links site -> its nearby points, then points
  const s = store.get();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  for (const p of D.points) {
    if (p.kind !== 'nearby') continue;
    const par = D.byId.get(p.parent);
    if (!par) continue;
    const [a, b] = toScreen(...par.xy), [c, d] = toScreen(...p.xy);
    ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke();
  }
  const col = { pass: '#d4ff24', fail: '#ff5a4f', na: '#8e96a8' };
  for (const p of D.points) {
    const [x, y] = toScreen(...p.xy);
    const st = statusFor(p.id, s);
    const r = p.kind === 'site' ? 7 : 4;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(3,4,7,0.75)'; ctx.fill();
    ctx.lineWidth = p.kind === 'site' ? 2.5 : 2; ctx.strokeStyle = col[st]; ctx.stroke();
    if (M.sel === p.id) {
      ctx.beginPath(); ctx.arc(x, y, r + 6, 0, 2 * Math.PI);
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    }
    if (p.kind === 'site') {
      ctx.font = '600 12px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#eceff5';
      ctx.fillText(shortName(p.name), x + 12, y - 8);
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.fillStyle = 'rgba(236,239,245,0.6)';
      ctx.fillText(p.id.toUpperCase(), x + 12, y + 5);
    }
  }
  if (M.miss) {
    const [x, y] = toScreen(...M.miss.xy);
    ctx.strokeStyle = '#f2a93b'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x - 7, y - 7); ctx.lineTo(x + 7, y + 7); ctx.moveTo(x + 7, y - 7); ctx.lineTo(x - 7, y + 7); ctx.stroke();
    const n = D.byId.get(M.miss.nearest);
    if (n) {
      const [a, b] = toScreen(...n.xy);
      ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(a, b); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // scale bar
  const target = 20000;
  const px = target * M.scale;
  const sx = 18, sy = M.h - 22;
  ctx.strokeStyle = '#eceff5'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + px, sy); ctx.stroke();
  ctx.fillStyle = '#eceff5'; ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.fillText('20 km', sx, sy - 6);
}

function nearestPoint(x, y) {
  let best = null, bd = Infinity;
  for (const p of D.points) {
    const d = Math.hypot(p.xy[0] - x, p.xy[1] - y);
    if (d < bd) { bd = d; best = p; }
  }
  return { p: best, d: bd };
}

function onClick(ev) {
  const rect = M.canvas.getBoundingClientRect();
  const [x, y] = toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
  const { p, d } = nearestPoint(x, y);
  // also accept a click near the marker on screen (helps when zoomed out)
  const [mx, my] = p ? toScreen(...p.xy) : [0, 0];
  if (p && (d <= SNAP_M || Math.hypot(mx - (ev.clientX - rect.left), my - (ev.clientY - rect.top)) <= 10)) {
    selectPoint(p.id);
  } else {
    M.sel = null;
    const [lat, lon] = fromXY(x, y);
    M.miss = { xy: [x, y], lat, lon, nearest: p?.id, dist: d };
    renderInspector();
    draw();
  }
}

async function selectPoint(id) {
  M.sel = id; M.miss = null;
  draw();
  renderInspector(true);
  try { await pointData(id); } catch { /* missing files: inspector shows — */ }
  renderInspector();
}

// ---------------------------------------------------------------- inspector
function renderInspector(loading = false) {
  const el = $('xp-inspect');
  if (!el) return;
  const s = store.get();
  if (M.miss) {
    const n = D.byId.get(M.miss.nearest);
    el.innerHTML = `
      <p class="micro">Clicked point</p>
      <h3 class="xp-title">Not computed here</h3>
      <p class="mono xp-meta">${fmtLat(M.miss.lat)} ${fmtLon(M.miss.lon)}</p>
      <p class="hint">LunaWise only shows Sun and Earth visibility where the full terrain + ephemeris
        pipeline was run (5 sites and 20 points 1 km around them). A horizon for this spot would need the
        200 km terrain search, so no numbers are shown.</p>
      ${n ? `<p class="hint">Nearest computed point: <b>${esc(n.name)}</b>, ${num(M.miss.dist / 1000, 1)} km away.</p>
      <div class="xp-actions"><button type="button" class="pill small" data-go="${n.id}">Go to it →</button></div>` : ''}`;
    return;
  }
  const p = M.sel && D.byId.get(M.sel);
  if (!p) {
    el.innerHTML = `<p class="micro">South Pole map</p>
      <h3 class="xp-title">Pick a point</h3>
      <p class="hint">Big rings are the 5 candidate sites; small rings are computed points 1 km north, east,
        south and west of each. Colour = this scenario (lime meets the requirements, red fails). Click a ring,
        or anywhere else to see the nearest computed point. Scroll to zoom, drag to pan.</p>`;
    return;
  }
  const r = D.results.get(p.id), a = D.angles.get(p.id);
  const ev = r ? evaluate(r, scenarioOpts(s), reqs(s)) : null;
  const parent = p.kind === 'nearby' ? D.byId.get(p.parent) : null;
  const evP = parent && D.results.get(parent.id) ? evaluate(D.results.get(parent.id), scenarioOpts(s), reqs(s)) : null;
  const h = s.currentHour;
  const now = r && a && h != null && r.t[h] ? (() => {
    const c = countdowns(r, h);
    return `
      <div class="xp-now">
        <div class="${r.sun_lit[h] ? 'up' : 'down'}"><i class="sun"></i><b>Sun ${r.sun_lit[h] ? 'up' : 'down'}</b>
          <span class="mono">az ${num(a.sun_az[h])}° · el ${num(a.sun_el[h], 2)}°${r.sun_margin_deg ? ` · ${signed(r.sun_margin_deg[h])}° vs ridge` : ''}</span>
          <em>${esc(countdownText(c.sun, 'sun'))}</em></div>
        <div class="${r.earth_vis[h] ? 'up' : 'down'}"><i class="earth"></i><b>Earth ${r.earth_vis[h] ? 'in view' : 'hidden'}</b>
          <span class="mono">az ${num(a.earth_az[h])}° · el ${num(a.earth_el[h], 2)}°${r.earth_margin_deg ? ` · ${signed(r.earth_margin_deg[h])}° vs ridge` : ''}</span>
          <em>${esc(countdownText(c.earth, 'earth'))}</em></div>
      </div>
      <p class="hint mono">${fmtTime(r.t[h])} (the timeline's current hour)</p>`;
  })() : `<p class="hint">${loading ? 'loading…' : '—'}</p>`;
  const delta = (v, pv, unit = '%') => (pv == null ? '' : `<small class="${v >= pv ? 'good' : 'bad'}">${signed(v - pv, 1)}${unit} vs site</small>`);
  const m = ev?.metrics, mp = evP?.metrics;
  const verdict = !ev ? '—' : ev.window.truncated || !ev.window.hours ? 'NO DATA' : ev.pass ? 'GO' : 'NO GO';
  const vstate = !ev || ev.window.truncated || !ev.window.hours ? 'na' : ev.pass ? 'pass' : 'fail';
  el.innerHTML = `
    <p class="micro">${p.kind === 'site' ? 'Candidate landing site' : `Computed point · ${esc(p.offset_dist_m / 1000)} km from ${esc(p.parent)}`}</p>
    <h3 class="xp-title">${esc(shortName(p.name))}</h3>
    <p class="mono xp-meta">${esc(p.id.toUpperCase())} · ${fmtLat(p.lat)} ${fmtLon(p.lon)} · ${Math.round(p.ground_height_m)} m</p>
    <div class="xp-verdict" data-state="${vstate}"><b>${verdict}</b>
      <span>${ev ? esc(failureMessage(ev.failure, shortName(p.name))) : ''}</span></div>
    <p class="hint">This scenario: landing ${ev?.window.startT ? fmtTime(ev.window.startT) : '—'}, ${s.durationDays} d, slip +${s.delayDays} d (Mission tab settings).</p>
    ${m ? `<div class="xp-grid">
      <div><span class="micro">Sunlit</span><b>${num(m.sunPct)}%</b>${delta(m.sunPct, mp?.sunPct)}</div>
      <div><span class="micro">Earth in view</span><b>${num(m.earthPct)}%</b>${delta(m.earthPct, mp?.earthPct)}</div>
      <div><span class="micro">Longest night</span><b>${m.longestNightH} h</b>${mp ? `<small class="${m.longestNightH <= mp.longestNightH ? 'good' : 'bad'}">${signed(m.longestNightH - mp.longestNightH, 0)} h vs site</small>` : ''}</div>
      <div><span class="micro">Longest comm gap</span><b>${m.longestCommGapH} h</b>${mp ? `<small class="${m.longestCommGapH <= mp.longestCommGapH ? 'good' : 'bad'}">${signed(m.longestCommGapH - mp.longestCommGapH, 0)} h vs site</small>` : ''}</div>
    </div>` : ''}
    ${r?.summary ? `<p class="hint">All of 2027 (2 m mast): Sun ${num(r.summary.sun_pct)}% · Earth ${num(r.summary.earth_pct)}% · longest night ${r.summary.longest_night_h} h · longest comm gap ${r.summary.longest_comm_gap_h} h.</p>` : ''}
    <h4 class="micro xp-sub">Right now</h4>
    ${now}
    <div class="xp-actions">
      <button type="button" class="pill small" data-plan="${p.id}">Plan an expedition here</button>
      ${p.kind === 'site' ? `<button type="button" class="pill small" data-open="${p.id}">Open in Mission tab</button>
        <button type="button" class="pill small" data-3d="${p.id}">View in 3D</button>`
      : `<button type="button" class="pill small ghost" data-open="${p.parent}">Open parent site</button>`}
    </div>
    ${p.kind === 'nearby' ? '<p class="hint">The 3D views cover the 5 candidate sites. This point\'s numbers are its own (same terrain + SPICE pipeline); its 3D terrain is the parent site\'s.</p>' : ''}`;
}

// ---------------------------------------------------------------- expedition planner
const DAY = 86400000;
const X = { pointId: null, start: '2027-01-09', end: '2027-03-10' };

function openPlanner(pointId) {
  const s = store.get();
  X.pointId = pointId || M.sel || s.siteId;
  if (!X.start) X.start = s.startDate.slice(0, 10);
  $('xp-modal').hidden = false;
  fillPlanner();
  runPlanner();
}
function fillPlanner() {
  const sel = $('xp-point');
  sel.innerHTML = `<optgroup label="Candidate sites">${D.points.filter((p) => p.kind === 'site').map((p) => `<option value="${p.id}">${esc(shortName(p.name))} (${p.id.toUpperCase()})</option>`).join('')}</optgroup>
    <optgroup label="Computed points 1 km away">${D.points.filter((p) => p.kind === 'nearby').map((p) => `<option value="${p.id}">${esc(shortName(p.name))}</option>`).join('')}</optgroup>`;
  sel.value = X.pointId;
  $('xp-start').value = X.start;
  $('xp-end').value = X.end;
}
function presetDays(days) {
  const st = Date.parse(`${X.start}T00:00:00Z`);
  const end = Math.min(st + days * DAY, Date.parse('2027-12-31T00:00:00Z'));
  X.end = new Date(end).toISOString().slice(0, 10);
  $('xp-end').value = X.end;
  runPlanner();
}
function runPlanner() {
  const out = $('xp-results');
  const s = store.get();
  const p = D.byId.get(X.pointId);
  const r = p && D.results.get(p.id);
  const st = Date.parse(`${X.start}T00:00:00Z`), en = Date.parse(`${X.end}T00:00:00Z`);
  document.querySelectorAll('.xp-preset').forEach((b) => b.classList.toggle('is-on', Math.round((en - st) / DAY) === Number(b.dataset.days)));
  if (!r) { out.innerHTML = '<p class="hint">Data not found for this point.</p>'; return; }
  if (!(en > st)) { out.innerHTML = '<p class="hint">The end date must be after the start date.</p>'; return; }
  const durationDays = (en - st) / DAY;
  const ev = evaluate(r, { startDate: `${X.start}T00:00:00Z`, delayDays: 0, durationDays }, reqs(s));
  const w = ev.window, m = ev.metrics;
  if (!w.hours) { out.innerHTML = '<p class="hint">This range is outside the computed data (2027).</p>'; return; }
  const bt = batteryTrace(r, w, s.lander);
  const state = w.truncated ? 'na' : ev.pass ? 'pass' : 'fail';
  const word = w.truncated ? 'PARTLY OUTSIDE 2027' : ev.pass ? 'EXPEDITION FEASIBLE' : 'EXPEDITION FAILS';
  out.innerHTML = `
    <div class="xp-verdict" data-state="${state}"><b>${word}</b>
      <span>${esc(failureMessage(ev.failure, shortName(p.name)))}${w.truncated ? ' The range runs past the computed data (2027-12-31), so only the part inside 2027 is counted.' : ''}</span></div>
    <div class="xp-grid xp-grid-3">
      <div><span class="micro">Duration</span><b>${num(w.hours / 24, 1)} d</b><small>${w.hours} h</small></div>
      <div><span class="micro">Sunlit</span><b>${num(m.sunPct)}%</b><small>${m.sunHours} h · need ≥ ${s.requirements.minSunPct}%</small></div>
      <div><span class="micro">Earth in view</span><b>${num(m.earthPct)}%</b><small>${m.earthHours} h</small></div>
      <div><span class="micro">Longest night</span><b>${m.longestNightH} h</b><small>limit ${s.requirements.maxNightH} h</small></div>
      <div><span class="micro">Longest comm gap</span><b>${m.longestCommGapH} h</b><small>limit ${s.requirements.maxCommGapH} h</small></div>
      <div><span class="micro">Battery low point</span><b>${Math.round(bt.minWh)} Wh</b><small>${num((100 * bt.minWh) / bt.params.capacityWh, 0)}% · scenario model</small></div>
    </div>
    <canvas id="xp-strip" class="xp-strip" height="58" aria-label="Sun and Earth visibility over the range"></canvas>
    <p class="hint">Rows: Sun visible, Earth visible, battery. Requirements and battery come from the Mission tab.
      ${ev.failure ? `First failure at ${fmtTime(ev.failure.timestamp)} (mission hour ${ev.failure.missionHour + 1}), marked in red.` : ''}</p>`;
  drawStrip(r, w, bt, ev.failure);
  const apply = $('xp-apply');
  apply.disabled = p.kind !== 'site';
  apply.title = p.kind === 'site' ? '' : 'The Mission tab and 3D views cover the 5 candidate sites';
  $('xp-apply-note').textContent = p.kind === 'site'
    ? 'Applying sets this site, landing date and length in the Mission tab, the timeline and the 3D views.'
    : 'Computed nearby points are evaluated here; the Mission tab and 3D views cover the 5 candidate sites.';
}
function drawStrip(r, w, bt, failure) {
  const c = $('xp-strip');
  if (!c) return;
  const W = c.clientWidth || 600, H = 58, dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(0, 0, W, H);
  const n = w.hours;
  for (let px = 0; px < W; px++) {
    const a = w.startIdx + Math.floor((px / W) * n), b = Math.max(a + 1, w.startIdx + Math.floor(((px + 1) / W) * n));
    let sun = 0, earth = 0;
    for (let k = a; k < b; k++) { sun += r.sun_lit[k]; earth += r.earth_vis[k]; }
    const fs = sun / (b - a), fe = earth / (b - a);
    ctx.fillStyle = `rgba(255,213,138,${0.15 + 0.85 * fs})`; ctx.fillRect(px, 2, 1, 16);
    ctx.fillStyle = `rgba(91,142,240,${0.15 + 0.85 * fe})`; ctx.fillRect(px, 21, 1, 16);
    const soc = bt.socWh[Math.min(bt.socWh.length - 1, a - w.startIdx)] / bt.params.capacityWh;
    ctx.fillStyle = 'rgba(212,255,36,0.8)'; ctx.fillRect(px, 40 + 16 * (1 - soc), 1, Math.max(1, 16 * soc));
  }
  if (failure) {
    const x = ((failure.hourIndex - w.startIdx) / n) * W;
    ctx.fillStyle = '#ff5a4f'; ctx.fillRect(x - 1, 0, 2, H);
  }
}
function applyPlanner() {
  const p = D.byId.get(X.pointId);
  if (!p || p.kind !== 'site') return;
  const st = Date.parse(`${X.start}T00:00:00Z`), en = Date.parse(`${X.end}T00:00:00Z`);
  const durationDays = Math.max(1, Math.round((en - st) / DAY));
  store.set({ siteId: p.id, startDate: `${X.start}T00:00:00Z`, delayDays: 0, durationDays, tab: 'mission' });
  $('xp-modal').hidden = true;
  closeMap();
}

// ---------------------------------------------------------------- UI injection
function buildUI() {
  const views = document.querySelector('.views');
  const mapBtn = document.createElement('button');
  mapBtn.type = 'button'; mapBtn.id = 'xp-map-btn'; mapBtn.textContent = 'South Pole map';
  views.appendChild(mapBtn);

  const actions = document.querySelector('.top-actions');
  const planBtn = document.createElement('button');
  planBtn.type = 'button'; planBtn.className = 'pill'; planBtn.id = 'xp-plan-btn'; planBtn.textContent = 'Expedition planner';
  actions.insertBefore(planBtn, actions.firstChild);

  const map = document.createElement('section');
  map.id = 'xp-map'; map.className = 'xp-map'; map.hidden = true;
  map.setAttribute('aria-label', 'South Pole map');
  map.innerHTML = `
    <div class="xp-canvas-wrap"><canvas id="xp-canvas"></canvas>
      <div class="xp-map-tools">
        <button type="button" class="pill small" id="xp-fit">Fit all sites</button>
        <span class="micro xp-src">Shaded relief: our LOLA heightmaps (61 km around each site) · polar stereographic, 0° (Earth side) up</span>
      </div>
      <div class="xp-legend micro"><span><i class="dot pass"></i>meets requirements</span><span><i class="dot fail"></i>fails</span>
        <span><i class="dot na"></i>no data</span><span><i class="dot small"></i>computed point 1 km away</span></div>
    </div>
    <aside class="xp-inspect" id="xp-inspect"></aside>`;
  document.querySelector('.stage').after(map);

  const modal = document.createElement('div');
  modal.id = 'xp-modal'; modal.className = 'xp-modal'; modal.hidden = true;
  modal.innerHTML = `
    <div class="xp-card" role="dialog" aria-modal="true" aria-labelledby="xp-modal-title">
      <div class="xp-card-head"><h2 class="h-sec" id="xp-modal-title">Expedition planner</h2>
        <button type="button" class="xp-close" id="xp-close" aria-label="Close planner">×</button></div>
      <p class="hint">Pick a computed point and any date range in 2027. Sun and Earth come from the hourly
        flags in <span class="mono">data_out/results</span>; requirements and the scenario battery from the Mission tab.</p>
      <div class="xp-form">
        <label><span class="micro">Point</span><select id="xp-point" class="site-select"></select></label>
        <label><span class="micro">Start (UTC)</span><input type="date" id="xp-start" min="2027-01-01" max="2027-12-30" /></label>
        <label><span class="micro">End (UTC)</span><input type="date" id="xp-end" min="2027-01-02" max="2027-12-31" /></label>
      </div>
      <div class="xp-presets"><span class="micro">Duration</span>
        ${[[14, '14 d'], [30, '30 d'], [60, '60 d'], [90, '90 d'], [355, 'Rest of 2027']].map(([d, l]) => `<button type="button" class="pill small xp-preset" data-days="${d}">${l}</button>`).join('')}
      </div>
      <div id="xp-results"></div>
      <div class="xp-actions"><button type="button" class="pill" id="xp-apply">Apply to the mission timeline</button></div>
      <p class="hint" id="xp-apply-note"></p>
    </div>`;
  document.getElementById('app').appendChild(modal);

  // events
  mapBtn.addEventListener('click', () => (M.open ? closeMap() : openMap()));
  views.querySelectorAll('button:not(#xp-map-btn)').forEach((b) => b.addEventListener('click', () => closeMap()));
  $('home-link')?.addEventListener('click', () => closeMap());
  planBtn.addEventListener('click', () => openPlanner());
  $('xp-close').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.hidden = true; });
  $('xp-point').addEventListener('change', (e) => { X.pointId = e.target.value; runPlanner(); });
  $('xp-start').addEventListener('change', (e) => { if (e.target.value) { X.start = e.target.value; runPlanner(); } });
  $('xp-end').addEventListener('change', (e) => { if (e.target.value) { X.end = e.target.value; runPlanner(); } });
  modal.querySelectorAll('.xp-preset').forEach((b) => b.addEventListener('click', () => presetDays(Number(b.dataset.days))));
  $('xp-apply').addEventListener('click', applyPlanner);

  $('xp-inspect').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.go) selectPoint(t.dataset.go);
    if (t.dataset.plan) openPlanner(t.dataset.plan);
    if (t.dataset.open) { store.set({ siteId: t.dataset.open, tab: 'mission' }); }
    if (t.dataset['3d']) { store.set({ siteId: t.dataset['3d'] }); closeMap(); store.set({ view: 'lander' }); }
  });
  $('xp-fit').addEventListener('click', () => { fit(); draw(); });

  M.canvas = $('xp-canvas');
  M.ctx = M.canvas.getContext('2d');
  M.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = M.canvas.getBoundingClientRect();
    const [wx, wy] = toWorld(e.clientX - rect.left, e.clientY - rect.top);
    M.scale *= Math.exp(-e.deltaY * 0.0015);
    M.scale = Math.min(Math.max(M.scale, 0.0005), 0.6);
    const [nx, ny] = toWorld(e.clientX - rect.left, e.clientY - rect.top);
    M.ox += wx - nx; M.oy += wy - ny;
    draw();
  }, { passive: false });
  M.canvas.addEventListener('pointerdown', (e) => { M.drag = { x: e.clientX, y: e.clientY, ox: M.ox, oy: M.oy, moved: false }; M.canvas.setPointerCapture(e.pointerId); });
  M.canvas.addEventListener('pointermove', (e) => {
    if (!M.drag) return;
    const dx = e.clientX - M.drag.x, dy = e.clientY - M.drag.y;
    if (Math.hypot(dx, dy) > 3) M.drag.moved = true;
    M.ox = M.drag.ox - dx / M.scale; M.oy = M.drag.oy + dy / M.scale;
    draw();
  });
  M.canvas.addEventListener('pointerup', (e) => { const d = M.drag; M.drag = null; if (d && !d.moved) onClick(e); });
  new ResizeObserver(() => M.open && resize()).observe(map);
}

function openMap() {
  M.open = true;
  $('xp-map').hidden = false;
  document.getElementById('app').dataset.xpMap = 'on';
  document.querySelectorAll('.views button').forEach((b) => b.classList.toggle('is-on', b.id === 'xp-map-btn'));
  if (!M.sel && !M.miss) M.sel = store.get().siteId;
  resize();
  if (M.sel) selectPoint(M.sel); else renderInspector();
}
function closeMap() {
  if (!M.open) return;
  M.open = false;
  $('xp-map').hidden = true;
  delete document.getElementById('app').dataset.xpMap;
  const v = store.get().view;
  document.querySelectorAll('.views button').forEach((b) => b.classList.toggle('is-on', b.dataset.view === v));
}

// ---------------------------------------------------------------- Sun/Earth size (×1 ×2 ×3 ×5)
// Visual only: enlarges the Sun and Earth discs in the 3D views so they are easy to see. No number
// changes. True angular sizes are about 0.53° (Sun) and 1.9° (Earth), drawn at ×1.
// The 3D twin is created inside app.js; its CelestialBodies instance is picked up the first time it
// updates (same module instance), so app.js and M4's files stay unchanged.
const SIZE = { mult: 1, bodies: new Set() };
const origUpdate = CelestialBodies.prototype.updatePositions;
CelestialBodies.prototype.updatePositions = function (...args) {
  if (!SIZE.bodies.has(this)) {
    SIZE.bodies.add(this);
    if (SIZE.mult !== 1 && this.sunMesh) setTimeout(() => this.setExaggeration(SIZE.mult), 0);
  }
  return origUpdate.apply(this, args);
};
function setBodySize(mult) {
  SIZE.mult = mult;
  for (const b of SIZE.bodies) b.setExaggeration(mult);
  document.querySelectorAll('.xp-size button').forEach((x) => {
    const on = Number(x.dataset.mult) === mult;
    x.classList.toggle('is-on', on);
    x.setAttribute('aria-pressed', String(on));
  });
  const note = $('hud-scale-note');
  if (note) {
    note.hidden = mult === 1;
    note.textContent = `Sun and Earth enlarged ×${mult} for visibility. True angular sizes (Sun 0.53°, Earth 1.9°) are drawn at ×1.`;
  }
}
function buildSizeButtons() {
  const old = $('t-scale');
  if (!old) return;
  old.hidden = true;                                    // replaced by the group below (same function)
  const g = document.createElement('span');
  g.className = 'xp-size';
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', 'Sun and Earth size');
  g.innerHTML = '<span class="micro">Size</span>' +
    [1, 2, 3, 5].map((m) => `<button type="button" class="tool${m === 1 ? ' is-on' : ''}" data-mult="${m}" aria-pressed="${m === 1}" title="Draw the Sun and Earth ${m === 1 ? 'at true size' : `${m}× larger`}">×${m}</button>`).join('');
  old.after(g);
  g.addEventListener('click', (e) => { const b = e.target.closest('button[data-mult]'); if (b) setBodySize(Number(b.dataset.mult)); });
}

// ---------------------------------------------------------------- realistic Sun + Earth (Moon view)
// MoonGlobe draws the Sun as a fixed-screen-size glow (sizeAttenuation: false, several times its true
// size) and Earth with a banded placeholder shader. Here, without editing MoonGlobe.js:
//  - Sun: sharp disc at its TRUE angular diameter (0.533 deg; no atmosphere on the Moon), limb
//    darkening, faint glare. Direction is unchanged: MoonGlobe's sunDir (SPICE az/el of the site).
//  - Earth: same mesh, position and true size (1.9 deg); new material with M4's continent/cloud texture,
//    lit by the real sunDir (so the phase is real), soft terminator, dark night side, atmosphere rim.
//    The surface pattern is illustrative: Earth's rotation (which side faces us) is not modelled.
const SUN_DIST = 2500;                               // MoonGlobe puts the Sun sprite at sunDir * 2500
const SUN_DIAM_DEG = 0.533;
function sunTexture() {
  const S = 512, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const rDisc = S / 8;                               // disc = 1/4 of the sprite width; the rest is glare
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2) / rDisc;
      const i = (y * S + x) * 4;
      let r, gg, b, a;
      if (d <= 1) {
        const mu = Math.sqrt(1 - d * d);
        const I = 1 - 0.56 * (1 - mu) - 0.2 * (1 - mu) ** 2;          // visible-light limb darkening
        r = 255; gg = 250 * (0.9 + 0.1 * I); b = 238 * (0.85 + 0.15 * I); a = 255 * Math.min(1, I * 1.15);
        const edge = Math.min(1, (1 - d) * rDisc);                     // 1-px antialiased edge
        a *= edge;
      } else {
        const t = d - 1;
        a = 255 * (0.16 * Math.exp(-t * 3.2) + 0.05 * Math.exp(-t * 0.9)); // faint glare, no "cloud"
        r = 255; gg = 244; b = 222;
      }
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = Math.max(0, Math.min(255, a));
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const EARTH_VERT = /* glsl */`
  varying vec3 vN; varying vec3 vW; varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const EARTH_FRAG = /* glsl */`
  uniform sampler2D map; uniform vec3 sunDir;
  varying vec3 vN; varying vec3 vW; varying vec2 vUv;
  void main() {
    vec3 n = normalize(vN), v = normalize(cameraPosition - vW);
    float ndl = dot(n, normalize(sunDir));
    float day = smoothstep(-0.08, 0.22, ndl);                        // soft terminator (atmosphere)
    vec3 albedo = texture2D(map, vUv).rgb;
    vec3 col = albedo * (0.06 + 1.25 * max(ndl, 0.0)) * day + albedo * 0.012 * (1.0 - day);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 2.6);
    col += vec3(0.32, 0.56, 1.0) * rim * (0.08 + 0.75 * smoothstep(-0.25, 0.35, ndl));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;
function realisticBodies(globe) {
  if (globe._xpBodies) return;
  globe._xpBodies = true;
  globe.sunSprite.visible = false;                                   // the fixed-size glow
  const disc = 2 * SUN_DIST * Math.tan((SUN_DIAM_DEG / 2) * DEG);   // disc diameter at that distance
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sunTexture(), sizeAttenuation: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
  }));
  sun.scale.set(disc * 4, disc * 4, 1);                              // texture: disc = 1/4 of the width
  globe.scene.add(sun);
  globe._xpSun = sun;
  const earthTex = CelestialBodies.prototype.generateEarthTexture.call({});
  earthTex.colorSpace = THREE.SRGBColorSpace;
  globe.earth.material = new THREE.ShaderMaterial({
    uniforms: { map: { value: earthTex }, sunDir: { value: globe.sunDir } },
    vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG,
  });
}
const origSetSky = MoonGlobe.prototype.setSky;
MoonGlobe.prototype.setSky = function (...args) {
  const r = origSetSky.apply(this, args);
  realisticBodies(this);
  this._xpSun?.position.copy(this.sunDir).multiplyScalar(SUN_DIST);
  return r;
};

// ---------------------------------------------------------------- 3D engine link + About LunaWise
// The twin link is relabelled and enlarged here (index.html unchanged). The About panel states the
// project's motive and what is new about it; every figure in it comes from our own checks
// (docs/validation, Member2/README, Member1 frame_check).
const ABOUT_HTML = `
  <div class="xp-card xp-about-card" role="dialog" aria-modal="true" aria-labelledby="xp-about-title">
    <div class="xp-card-head"><h2 class="h-sec" id="xp-about-title">About LunaWise</h2>
      <button type="button" class="xp-close" id="xp-about-close" aria-label="Close">×</button></div>
    <p class="xp-about-lead">The launch got delayed. Now what?</p>
    <h3 class="micro xp-about-h">Why we built it</h3>
    <p>Missions to the Moon's south pole, like NASA's Commercial Lunar Payload Services (CLPS) landers, depend on
      sunlight for power and a direct line of sight to Earth for radio. At the pole the Sun and Earth skim the horizon at
      only a few degrees, so a ridge tens of kilometres away can cut a lander off from either. Launch dates slip all the
      time, and every slip changes which sites and dates still work.</p>
    <p>The data to answer that exists (NASA's LOLA terrain, JPL ephemerides), but tools like QuickMap, Moon Trek and
      JPL Horizons are built for detailed analysis by specialists. LunaWise lets mission planners, educators and the
      public compare sites and dates in seconds: pick a site, slide the delay, and see which sites still work and the
      exact hour the first failure happens.</p>
    <h3 class="micro xp-about-h">What is new about it</h3>
    <ul class="xp-about-list">
      <li><b>Real terrain, not a smooth Moon.</b> Every site's skyline is computed from NASA's 5 m LOLA terrain plus the
        20 m south-pole map, searched out to 200 km in 720 directions, with the Moon's curvature included.</li>
      <li><b>Built around the delay.</b> Every hour of 2027 is computed, so a launch slip of 0–30 days instantly gives a
        GO / NO GO, the first failure and why: comm gap, night too long or battery empty.</li>
      <li><b>Verified Sun and Earth positions.</b> NASA/JPL SPICE in the Moon's own reference frame, cross-checked against
        JPL Horizons to within 0.0005°.</li>
      <li><b>A second, independent check in the browser.</b> A ray-cast through the 3D terrain agrees with the engine in
        99.65–100% of the hours it can check, shown live in the 3D view.</li>
      <li><b>Small moves, big changes.</b> We computed 20 alternative points 1 km from each site: at de Gerlache rim,
        1 km north drops sunlight from 83% to 9%. NASA Goddard's own maps show the same drop-offs.</li>
      <li><b>Nothing invented.</b> Every number on screen comes from NASA data and our computation, with limits stated
        openly. The site runs as static files, with no server, so it opens anywhere from a link.</li>
    </ul>
    <p class="hint">NASA Space Apps 2026 · challenge “CLPS Lunar Mission Browser” · Team OPUS. Methods, limits and the NASA
      Goddard comparison are in the “About the data” tab.</p>
  </div>`;
// The 3D engine launcher: a large card in the free slot under the planner panel (same size as the
// time dock), with a delayed hover/focus card in the style of a pro-tool tooltip (Blender / Unreal):
// name + action, one-line summary, what it does, controls, and the source it opens, greyed.
const ENGINE_ICON = `<svg class="xp-eng-icon" viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
  <path d="M32 6 56 19v26L32 58 8 45V19z"/><path d="M8 19l24 13 24-13M32 32v26"/>
  <path d="M8 45l10-7 7 4 9-10 9 6 13-9" stroke-width="1.2" opacity=".55"/>
  <circle cx="47" cy="12" r="3.4" fill="currentColor" stroke="none" opacity=".9"/></svg>`;
const ENGINE_TIP = `
  <div class="xp-tip-head"><b>3D Engine</b><span class="xp-tip-kbd">Click to open</span></div>
  <p class="xp-tip-desc">Open the lander digital twin: stand 2 m above the real terrain at the selected site and
    watch the Sun and Earth cross the sky, hour by hour.</p>
  <dl class="xp-tip-grid">
    <dt>Terrain</dt><dd>NASA LOLA heightmaps: 5 km at 10 m, 61 km at 120 m</dd>
    <dt>Sky</dt><dd>Sun and Earth from JPL SPICE, true size or enlarged</dd>
    <dt>Checks</dt><dd>Engine skyline line + independent ray-cast badge</dd>
    <dt>Replay</dt><dd>Play the mission window, jump to the first failure</dd>
    <dt>Views</dt><dd>Lander mast · Orbital overview with shadows</dd>
    <dt>Controls</dt><dd><kbd>Drag</kbd> look · <kbd>W A S D</kbd> walk · <kbd>Space</kbd> play</dd>
  </dl>
  <p class="xp-tip-src">Member4/twin.html · LanderSimulation · three.js / WebGL</p>`;
function buildAboutAndTwin() {
  const twin = $('link-twin');
  if (twin) {
    const slot = document.createElement('div');
    slot.className = 'xp-engine';
    document.getElementById('app').appendChild(slot);
    slot.appendChild(twin);                               // same element, same link (./twin.html)
    twin.className = 'xp-engine-btn';
    twin.removeAttribute('title');
    twin.setAttribute('aria-describedby', 'xp-engine-tip');
    twin.innerHTML = `${ENGINE_ICON}
      <span class="xp-eng-text"><span class="micro xp-eng-kicker">Lander digital twin</span>
        <span class="xp-eng-title">View our 3D engine</span>
        <span class="xp-eng-sub">Real NASA terrain at the lander mast</span></span>
      <span class="xp-eng-arrow" aria-hidden="true">↗</span>`;
    const tip = document.createElement('div');
    tip.className = 'xp-tip'; tip.id = 'xp-engine-tip'; tip.setAttribute('role', 'tooltip');
    tip.innerHTML = ENGINE_TIP;
    slot.appendChild(tip);
  }
  const actions = document.querySelector('.top-actions');
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'pill xp-about-pill'; btn.id = 'xp-about-btn'; btn.textContent = 'About LunaWise';
  actions.appendChild(btn);                                // top right, where the 3D engine link was
  const modal = document.createElement('div');
  modal.id = 'xp-about'; modal.className = 'xp-modal'; modal.hidden = true;
  modal.innerHTML = ABOUT_HTML;
  document.getElementById('app').appendChild(modal);
  const close = () => { modal.hidden = true; };
  // Shorter labels on smaller laptops, so the top bar stays on one line.
  const labels = [
    ['xp-about-btn', 'About LunaWise', 'About'], ['xp-plan-btn', 'Expedition planner', 'Planner'],
    ['btn-share', null, 'Share'],
  ];
  labels.forEach((l) => { const el = $(l[0]); if (el && l[1] === null) l[1] = el.textContent; });
  const mq = window.matchMedia('(max-width: 1200px)');
  const applyLabels = () => labels.forEach(([id, full, short]) => { const el = $(id); if (el) el.textContent = mq.matches ? short : full; });
  mq.addEventListener('change', applyLabels);
  applyLabels();
  btn.addEventListener('click', () => { modal.hidden = false; $('xp-about-close').focus(); });
  $('xp-about-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// ---------------------------------------------------------------- boot
async function boot() {
  buildUI();
  buildSizeButtons();
  buildAboutAndTwin();
  try { await loadAll(); } catch (e) { console.warn('[explorer] data not found', e); return; }
  M.ready = true;
  if (M.open) { fit(); draw(); renderInspector(); }
  // relief tiles, one site at a time (shared cache with the Moon view)
  for (const s of D.sites) {
    try {
      const { meta, far } = await loadFarHeightmap(s.id);
      D.tiles.push({ id: s.id, canvas: hillshade(meta, far), xy: toXY(s.lat, s.lon), axes: localAxes(s.lat, s.lon),
                     cell: meta.far.cell_m, half: (meta.far.nx * meta.far.cell_m) / 2 });
      if (M.open) draw();
    } catch { /* tile missing: the map shows without relief */ }
  }
}

store.subscribe((s, patch) => {
  const keys = Object.keys(patch);
  if (keys.some((k) => ['siteId', 'startDate', 'delayDays', 'durationDays', 'requirements', 'lander'].includes(k))) {
    if (M.open) { draw(); renderInspector(); }
    if (!$('xp-modal')?.hidden) runPlanner();
  } else if (keys.includes('currentHour') && M.open && M.sel) {
    renderInspector();
  }
});

boot();
