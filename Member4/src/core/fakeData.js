/**
 * Synthetic ephemeris & visibility dataset generator for Phase 1 simulation testing.
 * Produces 720 hours (30 Earth days) of mathematically coherent Sun and Earth angles,
 * plus a simulated launch delay scenario with a realistic mission failure event.
 */

export function generateFakeDataset(horizonOverlay, terrainMesh) {
  const totalHours = 720;
  const startTime = new Date('2027-01-01T00:00:00Z').getTime();

  const timestamps = [];
  const sunAz = new Float32Array(totalHours);
  const sunEl = new Float32Array(totalHours);
  const earthAz = new Float32Array(totalHours);
  const earthEl = new Float32Array(totalHours);

  const sunLit = new Uint8Array(totalHours);
  const earthVis = new Uint8Array(totalHours);

  // Synodic lunar period ~ 708.7 hours (29.53 Earth days)
  const synodicPeriodH = 708.73;

  for (let h = 0; h < totalHours; h++) {
    const t = new Date(startTime + h * 3600 * 1000).toISOString();
    timestamps.push(t);

    // Sun cycles 360° every ~708 hours
    const sunCycle = (h / synodicPeriodH) * 2 * Math.PI;
    let sAz = (h * (360.0 / synodicPeriodH)) % 360.0;
    // Solar elevation oscillates between -1.8° and +3.8° (grazing polar sunlight)
    let sEl = 1.2 + 2.6 * Math.sin(sunCycle);

    // Earth hovers in the north (azimuth ~12° to 24°) with ~27-day libration cycle
    const librationCycle = (h / 655.7) * 2 * Math.PI;
    let eAz = 18.0 + 6.0 * Math.sin(librationCycle);
    // Earth elevation oscillates around ~1.0° to 2.8°
    let eEl = 1.4 + 1.8 * Math.cos(librationCycle * 1.05);

    // Specific injected failure scenario around hour 124 (simulating launch delay)
    // Earth dips behind a ridge at az 18° between hours 124 and 165 (41 hours gap!)
    if (h >= 124 && h <= 165) {
      eEl = -0.4; // Well below ridge
    }

    sunAz[h] = sAz;
    sunEl[h] = sEl;
    earthAz[h] = eAz;
    earthEl[h] = eEl;

    // Check visibility against horizon mask
    const horizonAtSun = horizonOverlay.getHorizonElevation(sAz);
    const horizonAtEarth = horizonOverlay.getHorizonElevation(eAz);

    sunLit[h] = sEl > horizonAtSun ? 1 : 0;
    earthVis[h] = eEl > horizonAtEarth ? 1 : 0;
  }

  // Pre-calculate agreement with raycast
  let agreeCount = 0;
  for (let h = 0; h < totalHours; h++) {
    const raySun = testRaycast(sunAz[h], sunEl[h], terrainMesh);
    const maskSun = sunLit[h] === 1;
    if (raySun === maskSun) agreeCount++;
  }
  const agreementPct = ((agreeCount / totalHours) * 100).toFixed(1);

  return {
    totalHours,
    timestamps,
    sunAz,
    sunEl,
    earthAz,
    earthEl,
    sunLit,
    earthVis,
    agreementPct,
    firstFailure: {
      hourIndex: 124,
      timestamp: timestamps[124],
      type: 'COMM_GAP',
      durationHours: 41,
      blockingAz: earthAz[124],
      message: `Earth line-of-sight blocked for 41h starting 2027-01-06T04:00Z (Hour 124). Exceeds 24h limit.`,
    },
  };
}

/**
 * Independent raycast algorithm directly in JS (matches raycast.js specification)
 */
export function testRaycast(azDeg, elDeg, terrainMesh) {
  if (elDeg < -4.0) return false;

  const azRad = (azDeg * Math.PI) / 180;
  const elRad = (elDeg * Math.PI) / 180;
  const sinAz = Math.sin(azRad);
  const cosAz = Math.cos(azRad);
  const tanEl = Math.tan(elRad);
  const obsHeight = 2.0;

  // Step through near grid
  if (terrainMesh.nearGrid) {
    const near = terrainMesh.nearGrid;
    for (let dist = 10; dist <= near.maxDist; dist += near.cellM) {
      const x = dist * sinAz;
      const y = dist * cosAz;
      const r = Math.floor((y + near.sizeM / 2) / near.cellM);
      const c = Math.floor((x + near.sizeM / 2) / near.cellM);
      if (r >= 0 && r < near.ny && c >= 0 && c < near.nx) {
        const h = near.data[r * near.nx + c];
        const rayH = obsHeight + dist * tanEl;
        if (h > rayH) return false;
      }
    }
  }

  // Step through far grid
  if (terrainMesh.farGrid) {
    const far = terrainMesh.farGrid;
    for (let dist = 2500; dist <= far.maxDist; dist += far.cellM * 2) {
      const x = dist * sinAz;
      const y = dist * cosAz;
      const r = Math.floor((y + far.sizeM / 2) / far.cellM);
      const c = Math.floor((x + far.sizeM / 2) / far.cellM);
      if (r >= 0 && r < far.ny && c >= 0 && c < far.nx) {
        const h = far.data[r * far.nx + c];
        const rayH = obsHeight + dist * tanEl;
        if (h > rayH) return false;
      }
    }
  }

  return true;
}
