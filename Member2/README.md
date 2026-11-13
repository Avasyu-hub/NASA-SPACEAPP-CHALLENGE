# Member 2: Terrain and Simulation Data

This folder contains the terrain-data pipeline and the independent terrain
raycaster owned by Member 2. The pipeline reads the local lunar DEM files,
writes horizon masks and Three.js-compatible heightmaps, and never commits
the raw NASA input rasters.

## Setup

From `Member2\pipeline`:

```powershell
python -m pip install -e ".[test]"
python -m pytest
```

The pipeline needs NumPy, Rasterio, and pyproj. Raw inputs are expected at
`data_raw\dem\near` and `data_raw\dem\far` in the repository root; the source
rasters are ignored by Git.

## Generate assets

Provide a verified site coordinate that falls inside its near-field GeoTIFF.
Coordinates are not inferred from a filename or guessed from a site label.
For example, from `Member2\pipeline`:

```powershell
python -m lunawise_terrain.compute_mask `
  --site-id site04 --lat <verified-latitude> --lon <verified-longitude> `
  --near ..\..\data_raw\dem\near\Site04_final_adj_5mpp_surf.tif `
  --far ..\..\data_raw\dem\far\LDEM_80S_20M_FLOAT.IMG `
  --out ..\..\data_out

python -m lunawise_terrain.export_heightmaps `
  --site-id site04 --lat <verified-latitude> --lon <verified-longitude> `
  --near ..\..\data_raw\dem\near\Site04_final_adj_5mpp_surf.tif `
  --far ..\..\data_raw\dem\far\LDEM_80S_20M_FLOAT.IMG `
  --out ..\..\data_out
```

The `--far` argument uses the adjacent PDS `.LBL` file to read the raw
little-endian float raster and its polar-stereographic mapping. The mask
command requires complete far-field coverage to the requested search radius;
it stops rather than publishing an incomplete profile. `--allow-incomplete`
can be used for diagnostics, and the output records per-azimuth coverage.

Generated files follow the existing `data_out` layout:

- `mask\<site>.json`: 360-bin profiles for 2 m, 5 m, and 10 m mast heights.
- `heightmap\<site>.json`: grid dimensions, axes, filenames, and coverage.
- `heightmap\<site>_near.bin`, `heightmap\<site>_far.bin`: little-endian
  Float32 terrain heights relative to the site, with lunar curvature removed.
- `sites.json`: site coordinates, sampled ground elevation, and input source.

The binary heightmaps use row-major cells with +X east and +Y north; rows are
ordered north-to-south. Their height values are relative to the local ground
and already include spherical-curvature sag, so the browser raycaster must not
apply curvature a second time.

## Numerical notes

- The far-field PDS elevations are kilometres relative to the labeled
  1,737.4 km reference sphere; the pipeline converts them to metres.
- Horizon angles use a spherical 3-D observer-to-terrain vector, not a flat
  map-projection slope. Azimuth is clockwise from north.
- Invalid DEM samples are not replaced with synthetic terrain. Missing
  coverage is reported and prevents normal production output.
- The site coordinate must be independently verified. The current source
  bundle does not provide authoritative coordinates for every candidate.
