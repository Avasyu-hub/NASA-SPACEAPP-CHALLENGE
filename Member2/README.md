# Member 2: Terrain (horizon masks, heightmaps, ray-cast check)

Writes the terrain files in `data_out/` that M1 (combine) and M4 (lander view) read, following
the contract in `goal.md` section 5.2. Raw NASA rasters stay out of git (`data_raw/` is ignored).

## Run

From `Member2/`:

```powershell
py -m pip install -r ..\requirements.txt
py -m pytest pipeline/tests -q          # 14 tests, synthetic DEMs (no downloads needed)
py -m pipeline.export --all             # all 5 sites, about 1 minute; needs data_raw/ (below)
npm test                                # ray-cast checks, incl. agreement on the real data_out/
```

`--data-raw <folder>` points at a `data_raw/` somewhere else. `--site site04` runs one site.

## Outputs (`data_out/`)

| File | Contract | Notes |
|---|---|---|
| `sites.json` | #1 | lat/lon/ground height read from the DEM at the chosen site point |
| `mask/<id>.json` | #3 | `elev_deg`: 360 bins, 2 m mast, az 0..359 clockwise from north. Extra fields: `elev_deg_by_mast` (0/2/5/10 m), `elev_deg_720_by_mast` (0.5 deg), `horizon_dist_km_by_mast` (how far away the blocking terrain is), `search_km`, `dem.far_minus_near` |
| `heightmap/<id>.json`, `<id>_near.bin`, `<id>_far.bin` | #5 | near 512x512 at 10 m (5.12 km), far 512x512 at 120 m (61.44 km). Float32 LE, row 0 = southernmost, x = east, y = north, heights relative to the lander ground with curvature d^2/2R already subtracted, sampled at cell centres |

`mask` is computed to **200 km** (the far heightmap is only for the 3D view and the ray-cast check).

## Method
- Horizon: for each azimuth, geodesic samples from the site (every 5 m pixel across the near tile,
  then max(5 m, 0.5 % of distance)) to 200 km; exact 3D elevation angle on the R = 1737.4 km sphere;
  mask = maximum. Near = PGDA 78 5 m tile, beyond it LOLA LDEM_80S_20M.
- Far DEM sanity check: far minus near over each 5 m tile, median within 0.06 m (MAD < 1 m) on all sites.
  The export stops if this is over 50 m (catches km/m or offset mistakes).
- Site points (never typed in):
  - Site01/04/07/11: the largest PGDA ROI in `SiteXX_ROIs.shp`. These are regions > 2500 m2 with
    > 70 % average illumination, Barker et al. 2021.
  - Site23: PGDA has no ROI file, so the same rule is applied to the PGDA 69 average-illumination
    map (`pipeline/site_from_illum.py`). On the four sites that have ROIs, that rule lands
    55-232 m from a PGDA ROI point.
- Ray-cast check (`src/raycast.js`): marches a straight ray through the near and far grids. It agrees
  with the mask in 99.7-100 % of checkable samples on all 5 sites. Samples blocked beyond the
  30.7 km grid can't be checked and are counted separately. This shows the conventions match
  (azimuth, axes, row order, curvature), not that the terrain is accurate.

## Limits
- Site23's search reaches only 181 km in some directions (edge of LDEM_80S_20M).
- The 0 m mask is dominated by the neighbouring 5 m pixels; use 2 m for results.
- DEM interpolation: PGDA 5 m tiles are ~90 % interpolated pixels (Barker et al. 2021).

## Raw data (`data_raw/`, not committed)
| Path | Source |
|---|---|
| `dem/near/SiteXX_final_adj_5mpp_surf.tif` (01, 04, 07, 11, 23) | https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/SiteXX/ |
| `roi/SiteXX/SiteXX_ROIs.shp` (01, 04, 07, 11) | same folder, `SiteXX_ROIs.tgz` (Site23 has none) |
| `dem/far/LDEM_80S_20M_FLOAT.IMG` + `.LBL` (3.7 GB) | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/float_img/ |
| `illum/AVGVISIB_85S_060M_201608.TIF` (34 MB) | https://pgda.gsfc.nasa.gov/data/MoonIllumination/ |

The far IMG is opened through its `.LBL`. Values are **km** above 1737.4 km; GDAL reports OFFSET = 1737.4,
which must not be added (handled in `pipeline/export.py`).
