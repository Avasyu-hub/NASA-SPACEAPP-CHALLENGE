# LunaWise app shell (dashboard + Moon + digital twin)

`Member4/index.html` is now the one LunaWise app (WORKPLAN.md 3.1). M4's original full-screen twin UI
is unchanged and still built, at `Member4/twin.html` (linked as "Full digital twin").

```
npm ci
npm run dev      # copies ../data_out -> public/data, then serves http://localhost:5173
npm run build    # dist/ (index.html + twin.html), deploy dist/ to GitHub Pages
```

## What is on screen

| View | What it shows | Data |
|---|---|---|
| **Moon** | The Moon at true scale, lit by the computed Sun for the current hour; the five sites (green = meets requirements, red = fails); dashed rays from the selected site to the Sun and Earth (red = blocked); each site's 61 km LOLA far-field heightmap draped at the pole | `sites.json`, `angles/`, `results/`, `heightmap/*_far.bin` |
| **Orbit site / Lander mast** | M4's `LanderSimulation` (unchanged), driven by the same store | M4's loaders |
| Mission tab | GO / NO GO from `evaluate()`, `failureMessage()` text, landing date, slip 0–30 d, duration, requirements, scenario battery, window metrics with change vs on-time, solar elevation, ridge margin, sunset/earthset countdowns, 360° skyline with Sun/Earth tracks | `missionLogic.js`, `mask/`, `angles/` |
| Compare tab | `rankSites()` table, delay-tolerance strip (`delayScan()` 0–30 d), 2027 landing-date calendar | `missionLogic.js` |
| About tab | method, limits, sources, NASA Goddard comparison table, team, AI disclosure | `docs/validation/goddard_terrain.json` |
| Bottom dock | one player for every view, UTC clock, Sun/Earth az/el, timeline (Sun / Earth / battery, on-time lane when slipped, failing run outlined, click or drag to scrub) | `results/`, `batteryTrace()` |

## Files
- `src/store.js` — shared store (WORKPLAN 3.2) plus URL hash state (`#site=site11&start=2027-01-09&delay=3…`).
- `src/dashboard/app.js` — wiring, rendering, playback, sync with the 3D twin.
- `src/dashboard/MoonGlobe.js` — whole-Moon Three.js view. Geometry is exact: site lat/lon in MOON_ME,
  Sun/Earth directions rotated from each site's local az/el, tile heights = heightmap + ground height +
  the curvature the export removed. The global photo map (`public/textures/moon_map.jpg`, LRO WAC) is
  context only and fades to a flat tone near the pole, where it smears.
- `src/dashboard/timeline.js`, `src/dashboard/data.js`, `src/dashboard/dashboard.css`.

Rule 1 holds: no metric is typed in. `grep -rnE "[0-9]+\.[0-9]+%" Member4/src/dashboard Member4/index.html` is empty.
