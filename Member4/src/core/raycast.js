/**
 * Independent Terrain-Ray Visibility Algorithm.
 * Implements line-of-sight ray marching through near and far heightmap grids
 * with spherical lunar curvature accounted for.
 * 
 * Used for off-thread validation to verify consistency against the Python engine's
 * precomputed horizon masks.
 */

/**
 * Checks if a celestial body at (azDeg, elDeg) is visible from (0, 0, obsHeightM)
 * or occluded by the terrain heightmap.
 * 
 * @param {number} azDeg - Azimuth clockwise from North [0, 360)
 * @param {number} elDeg - Elevation above local horizontal (degrees)
 * @param {number} obsHeightM - Observer mast height (typically 2.0m)
 * @param {object} nearGrid - { data: Float32Array, nx, ny, cellM, sizeM, maxDist }
 * @param {object} farGrid - { data: Float32Array, nx, ny, cellM, sizeM, maxDist }
 * @returns {boolean} True if visible, False if blocked by terrain
 */
export function checkVisibilityRay(azDeg, elDeg, obsHeightM, nearGrid, farGrid) {
  // If well below mathematical horizon, blocked immediately
  if (elDeg < -4.5) return false;

  const azRad = (azDeg * Math.PI) / 180;
  const elRad = (elDeg * Math.PI) / 180;
  const sinAz = Math.sin(azRad);
  const cosAz = Math.cos(azRad);
  const tanEl = Math.tan(elRad);

  // 1. Ray march through near grid (5m/10m resolution)
  if (nearGrid && nearGrid.data) {
    const stepNear = nearGrid.cellM || 10.0;
    const maxNear = nearGrid.maxDist || (nearGrid.sizeM / 2);

    for (let dist = stepNear; dist <= maxNear; dist += stepNear) {
      const x = dist * sinAz;
      const y = dist * cosAz;

      const r = Math.floor((y + nearGrid.sizeM / 2) / nearGrid.cellM);
      const c = Math.floor((x + nearGrid.sizeM / 2) / nearGrid.cellM);

      if (r >= 0 && r < nearGrid.ny && c >= 0 && c < nearGrid.nx) {
        const terrainH = nearGrid.data[r * nearGrid.nx + c];
        const rayH = obsHeightM + dist * tanEl;

        if (terrainH > rayH) {
          return false; // Occluded by near terrain
        }
      }
    }
  }

  // 2. Ray march through far grid (20m/120m resolution)
  if (farGrid && farGrid.data) {
    const stepFar = (farGrid.cellM || 120.0) * 1.5;
    const startFar = nearGrid ? nearGrid.maxDist : stepFar;
    const maxFar = farGrid.maxDist || (farGrid.sizeM / 2);

    for (let dist = startFar + stepFar; dist <= maxFar; dist += stepFar) {
      const x = dist * sinAz;
      const y = dist * cosAz;

      const r = Math.floor((y + farGrid.sizeM / 2) / farGrid.cellM);
      const c = Math.floor((x + farGrid.sizeM / 2) / farGrid.cellM);

      if (r >= 0 && r < farGrid.ny && c >= 0 && c < farGrid.nx) {
        const terrainH = farGrid.data[r * farGrid.nx + c];
        const rayH = obsHeightM + dist * tanEl;

        if (terrainH > rayH) {
          return false; // Occluded by far ridge/peak
        }
      }
    }
  }

  return true; // Unobstructed line of sight
}
