import { checkVisibilityRay } from './raycast.js';

self.onmessage = ({ data }) => {
  const {
    sunAz,
    sunEl,
    earthAz,
    earthEl,
    sunLitEngine,
    earthVisEngine,
    nearGrid,
    farGrid,
    obsHeightM,
  } = data;
  const totalHours = sunAz.length;
  if (
    totalHours === 0 ||
    sunEl.length !== totalHours ||
    earthAz.length !== totalHours ||
    earthEl.length !== totalHours ||
    sunLitEngine.length !== totalHours ||
    earthVisEngine.length !== totalHours
  ) {
    throw new TypeError('Raycast inputs must be non-empty arrays of equal length');
  }

  let sunAgreed = 0;
  let earthAgreed = 0;
  const sunRayFlags = new Uint8Array(totalHours);
  const earthRayFlags = new Uint8Array(totalHours);

  for (let hour = 0; hour < totalHours; hour += 1) {
    const sunVisible = checkVisibilityRay(
      sunAz[hour],
      sunEl[hour],
      obsHeightM,
      nearGrid,
      farGrid,
    );
    const earthVisible = checkVisibilityRay(
      earthAz[hour],
      earthEl[hour],
      obsHeightM,
      nearGrid,
      farGrid,
    );

    sunRayFlags[hour] = Number(sunVisible);
    earthRayFlags[hour] = Number(earthVisible);
    if (sunRayFlags[hour] === sunLitEngine[hour]) sunAgreed += 1;
    if (earthRayFlags[hour] === earthVisEngine[hour]) earthAgreed += 1;
  }

  self.postMessage(
    {
      totalHours,
      sunAgreementPct: ((sunAgreed / totalHours) * 100).toFixed(1),
      earthAgreementPct: ((earthAgreed / totalHours) * 100).toFixed(1),
      overallAgreementPct: (((sunAgreed + earthAgreed) / (totalHours * 2)) * 100).toFixed(1),
      sunRayFlags,
      earthRayFlags,
    },
    [sunRayFlags.buffer, earthRayFlags.buffer],
  );
};
