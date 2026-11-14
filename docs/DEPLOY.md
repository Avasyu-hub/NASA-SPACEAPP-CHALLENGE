# Deploying LunaWise (Cloudflare Pages)

LunaWise is a **static site**: no server, no database. The build produces `Member4/dist/`
(about 33 MB, ~110 files, largest file 1 MB; well inside Cloudflare Pages' 20,000-file / 25 MiB-per-file limits).

The build pulls every member's work into that one folder:

| In the site | Comes from |
|---|---|
| the app (3D lander view, 2D map, controls) | `Member4/` (M4); the dashboard goes here too (M3) |
| mission rules, first failure, battery, countdowns, Sun elevation | `web/src/core/missionLogic.js` (M1) |
| ray-cast consistency check (Web Worker) | `Member2/src/raycast.js`, `raycastWorker.js` (M2) |
| all data: sites, nearby points, masks, heightmaps, angles, results, validation | `data_out/` (M1 + M2), copied to `dist/data/` by `Member4/scripts/sync-data.mjs` before every build |

Because the app reads `../data_out`, `../web` and `../Member2`, **Cloudflare must build from the
repository root**, not from `Member4/`.

## Option A: connect the GitHub repo (recommended: redeploys on every push to `main`)

Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → pick
`Avasyu-hub/NASA-SPACEAPP-CHALLENGE`, then:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | `None` |
| Build command | `npm ci --prefix Member4 && npm run build --prefix Member4` |
| Build output directory | `Member4/dist` |
| Root directory (advanced) | *(leave empty = repository root)* |
| Environment variable | `NODE_VERSION` = `20` |

Save and deploy. The site appears at `https://<project-name>.pages.dev`. Every push to `main`
rebuilds it; pull requests get preview URLs.

## Option B: upload a build from your laptop (no Git connection)

From the repository root:
```
npm ci --prefix Member4
npm run build --prefix Member4
npx wrangler pages deploy Member4/dist --project-name lunawise
```
`wrangler` asks you to log in to Cloudflare in the browser the first time. Re-run the last two
commands after every change you want to publish.

## Before the demo: check
- The page footer reads **"DATA: NASA LOLA 5 m / 20 m terrain · JPL SPICE ephemeris…"**, not "SYNTHETIC".
  "SYNTHETIC" means `data/` didn't make it into the build.
- The RAYCAST box shows computed numbers (e.g. Site04 "Sun 99.8% of 8423 h"), not "computing…" forever.
- Open it logged out, in incognito, and on a phone.
- **Internet at the venue:** the 3D view and the data work offline once loaded. M4's 2D map still fetches
  its background image and custom-point terrain live from NASA Trek, so those parts need internet.

## Build check on GitHub
`.github/workflows/build-check.yml` runs the M1/M2 tests and the same build on every push and pull
request. It does **not** deploy. A red ✗ there means Cloudflare's build would fail too.
