// Loads data_out/ (served at ./data) for the dashboard. Cached per site. Never invents values:
// a missing file is reported as an error and the UI shows "—".
const BASE = './data';
const cache = new Map();

async function json(path) {
  const r = await fetch(`${BASE}/${path}`);
  if (!r.ok) throw new Error(`data not found: ${path}`);
  return r.json();
}

function once(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

export const loadSites = () => once('sites', () => json('sites.json'));
export const loadResults = (id) => once(`results/${id}`, () => json(`results/${id}.json`));
export const loadAngles = (id) => once(`angles/${id}`, () => json(`angles/${id}.json`));
export const loadMask = (id) => once(`mask/${id}`, () => json(`mask/${id}.json`));

/** Heightmap meta + far-field grid (Float32, row 0 = southernmost, x = east, y = north). */
export const loadFarHeightmap = (id) => once(`hm/${id}`, async () => {
  const meta = await json(`heightmap/${id}.json`);
  const r = await fetch(`${BASE}/heightmap/${meta.far.file}`);
  if (!r.ok) throw new Error(`data not found: heightmap/${meta.far.file}`);
  return { meta, far: new Float32Array(await r.arrayBuffer()) };
});
