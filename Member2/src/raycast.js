const DEG_TO_RAD = Math.PI / 180;

function normalizeGrid(grid) {
  if (!grid) return null;

  const { data, nx, ny, cellM } = grid;
  if (
    !data ||
    !Number.isInteger(nx) ||
    !Number.isInteger(ny) ||
    nx <= 0 ||
    ny <= 0 ||
    data.length !== nx * ny ||
    !Number.isFinite(cellM) ||
    cellM <= 0
  ) {
    throw new TypeError('Terrain grid must have valid dimensions, cellM, and data');
  }

  const maxDist = grid.maxDist ?? Math.min(nx, ny) * cellM / 2;
  if (!Number.isFinite(maxDist) || maxDist <= 0) {
    throw new TypeError('Terrain grid maxDist must be positive and finite');
  }
  return { data, nx, ny, cellM, maxDist };
}

function sampleTerrainMaximum(grid, xM, yM) {
  const col = grid.nx / 2 + xM / grid.cellM - 0.5;
  const row = grid.ny / 2 - yM / grid.cellM - 0.5;
  if (col < 0 || col > grid.nx - 1 || row < 0 || row > grid.ny - 1) {
    return null;
  }

  const col0 = Math.floor(col);
  const row0 = Math.floor(row);
  const col1 = Math.min(col0 + 1, grid.nx - 1);
  const row1 = Math.min(row0 + 1, grid.ny - 1);
  const values = [
    grid.data[row0 * grid.nx + col0],
    grid.data[row0 * grid.nx + col1],
    grid.data[row1 * grid.nx + col0],
    grid.data[row1 * grid.nx + col1],
  ];
  let maximum = -Infinity;
  for (const value of values) {
    if (Number.isFinite(value)) maximum = Math.max(maximum, value);
  }
  return maximum === -Infinity ? null : maximum;
}

function isBlocked(grid, sinAz, cosAz, tanEl, observerHeightM) {
  const step = grid.cellM / 2;
  for (let distanceM = step; distanceM <= grid.maxDist; distanceM += step) {
    const terrainHeightM = sampleTerrainMaximum(
      grid,
      distanceM * sinAz,
      distanceM * cosAz,
    );
    if (terrainHeightM === null) continue;

    const rayHeightM = observerHeightM + distanceM * tanEl;
    if (terrainHeightM > rayHeightM) return true;
  }
  return false;
}

/**
 * Checks visibility through the supplied curvature-corrected terrain grids.
 * Grid heights are relative to the site ground and already include spherical
 * sag; the ray therefore stays straight in the local tangent-plane frame.
 */
export function checkVisibilityRay(azDeg, elDeg, observerHeightM, nearGrid, farGrid) {
  if (![azDeg, elDeg, observerHeightM].every(Number.isFinite) || observerHeightM < 0) {
    throw new TypeError('Azimuth, elevation, and non-negative observer height must be finite');
  }

  const grids = [normalizeGrid(nearGrid), normalizeGrid(farGrid)].filter(Boolean);
  if (grids.length === 0) {
    throw new TypeError('At least one terrain grid is required');
  }

  const azimuthRad = azDeg * DEG_TO_RAD;
  const elevationRad = elDeg * DEG_TO_RAD;
  const sinAz = Math.sin(azimuthRad);
  const cosAz = Math.cos(azimuthRad);
  const tanEl = Math.tan(elevationRad);

  return !grids.some((grid) => isBlocked(grid, sinAz, cosAz, tanEl, observerHeightM));
}
