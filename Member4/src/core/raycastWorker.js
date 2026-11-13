/**
 * Web Worker for Off-Thread Raycast Consistency Computation.
 * Computes ray-terrain intersection for all hours (up to 8,760 hours)
 * without dropping a single frame from the 60 FPS Three.js rendering thread.
 */

// Self-contained raycast logic inside the worker
function checkRay(azDeg, elDeg, obsHeightM, nearGrid, farGrid) {
  if (elDeg < -4.5) return false;

  const azRad = (azDeg * Math.PI) / 180;
  const elRad = (elDeg * Math.PI) / 180;
  const sinAz = Math.sin(azRad);
  const cosAz = Math.cos(azRad);
  const tanEl = Math.tan(elRad);

  if (nearGrid && nearGrid.data) {
    const stepNear = nearGrid.cellM || 10.0;
    const maxNear = nearGrid.maxDist || (nearGrid.sizeM / 2);

    for (let dist = stepNear; dist <= maxNear; dist += stepNear) {
      const x = dist * sinAz;
      const y = dist * cosAz;
      const r = Math.floor((y + nearGrid.sizeM / 2) / nearGrid.cellM);
      const c = Math.floor((x + nearGrid.sizeM / 2) / nearGrid.cellM);

      if (r >= 0 && r < nearGrid.ny && c >= 0 && c < nearGrid.nx) {
        if (nearGrid.data[r * nearGrid.nx + c] > obsHeightM + dist * tanEl) {
          return false;
        }
      }
    }
  }

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
        if (farGrid.data[r * farGrid.nx + c] > obsHeightM + dist * tanEl) {
          return false;
        }
      }
    }
  }

  return true;
}

self.onmessage = function (e) {
  const { sunAz, sunEl, earthAz, earthEl, sunLitEngine, earthVisEngine, nearGrid, farGrid, obsHeightM } = e.data;

  const totalHours = sunAz.length;
  let sunAgreed = 0;
  let earthAgreed = 0;

  const sunRayFlags = new Uint8Array(totalHours);
  const earthRayFlags = new Uint8Array(totalHours);

  for (let h = 0; h < totalHours; h++) {
    const sVisible = checkRay(sunAz[h], sunEl[h], obsHeightM, nearGrid, farGrid);
    const eVisible = checkRay(earthAz[h], earthEl[h], obsHeightM, nearGrid, farGrid);

    sunRayFlags[h] = sVisible ? 1 : 0;
    earthRayFlags[h] = eVisible ? 1 : 0;

    if (sunRayFlags[h] === sunLitEngine[h]) sunAgreed++;
    if (earthRayFlags[h] === earthVisEngine[h]) earthAgreed++;
  }

  const sunAgreementPct = ((sunAgreed / totalHours) * 100).toFixed(1);
  const earthAgreementPct = ((earthAgreed / totalHours) * 100).toFixed(1);
  const overallAgreementPct = (((sunAgreed + earthAgreed) / (totalHours * 2)) * 100).toFixed(1);

  self.postMessage({
    totalHours,
    sunAgreementPct,
    earthAgreementPct,
    overallAgreementPct,
    sunRayFlags,
    earthRayFlags,
  });
};
