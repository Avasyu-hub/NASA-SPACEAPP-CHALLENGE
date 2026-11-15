// Shared state between the dashboard and the 3D view (WORKPLAN.md section 3.2, owned by M3).
// Defaults are user inputs, not results: nominal landing 9 Jan 2027 (WORKPLAN section 12),
// limits 40 % / 36 h / 24 h (goal.md 8.2) and the scenario battery (goal.md 6.5).
const state = {
  siteId: 'site04',
  startDate: '2027-01-09T00:00:00Z',     // nominal landing
  delayDays: 0,                            // 0..30
  durationDays: 14,
  currentHour: null,                       // absolute index into results.t / angles
  isPlaying: false,
  speed: 10,
  requirements: { minSunPct: 40, maxNightH: 36, maxCommGapH: 24 },
  lander: { capacityWh: 1500, solarW: 250, loadW: 80 },   // scenario assumption, not NASA data
  // UI only (not part of the mission rules)
  view: 'moon',                            // 'moon' | 'lander' | 'overview'
  tab: 'mission',                          // 'mission' | 'compare' | 'about'
  sortBy: 'bothPct',
};

const subs = new Set();

export const store = {
  get: () => state,
  set(patch) {
    Object.assign(state, patch);
    subs.forEach((f) => f(state, patch));
  },
  subscribe(f) {
    subs.add(f);
    return () => subs.delete(f);
  },
};

// Scenario <-> URL hash, so a scenario is a shareable link (README section 7).
// #site=site11&start=2027-01-09&delay=3&dur=14&sun=40&night=36&gap=24&view=lander
export function readHash() {
  const p = new URLSearchParams((window.location.hash || '').replace(/^#/, '') || window.location.search);
  const out = {};
  const int = (k, lo, hi) => {
    if (!p.has(k)) return undefined;
    const v = Number(p.get(k));
    return Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined;
  };
  if (/^site\d+$/.test(p.get('site') || '')) out.siteId = p.get('site');
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.get('start') || '')) out.startDate = `${p.get('start')}T00:00:00Z`;
  const delay = int('delay', 0, 30); if (delay !== undefined) out.delayDays = delay;
  const dur = int('dur', 1, 30); if (dur !== undefined) out.durationDays = dur;
  const req = { ...state.requirements };
  const sun = int('sun', 0, 100); if (sun !== undefined) req.minSunPct = sun;
  const night = int('night', 0, 720); if (night !== undefined) req.maxNightH = night;
  const gap = int('gap', 0, 720); if (gap !== undefined) req.maxCommGapH = gap;
  out.requirements = req;
  if (['moon', 'lander', 'overview'].includes(p.get('view'))) out.view = p.get('view');
  return out;
}

export function writeHash(s) {
  const p = new URLSearchParams({
    site: s.siteId,
    start: s.startDate.slice(0, 10),
    delay: String(s.delayDays),
    dur: String(s.durationDays),
    sun: String(s.requirements.minSunPct),
    night: String(s.requirements.maxNightH),
    gap: String(s.requirements.maxCommGapH),
    view: s.view,
  });
  const h = `#${p.toString()}`;
  if (window.location.hash !== h) {
    try { history.replaceState(null, '', h); } catch { /* sandboxed frame: ignore */ }
  }
}
