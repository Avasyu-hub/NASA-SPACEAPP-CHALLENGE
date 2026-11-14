import { LanderSimulation } from './simulation/LanderSimulation.js';

// DOM Elements
const container = document.getElementById('simulation-container');
const timeSlider = document.getElementById('time-slider');
const frameInput = document.getElementById('frame-input');
const timeIsoText = document.getElementById('time-iso-text');
const sunCoordsText = document.getElementById('sun-coords-text');
const earthCoordsText = document.getElementById('earth-coords-text');

const siteSelector = document.getElementById('site-selector');
const badgeSun = document.getElementById('badge-sun');
const badgeEarth = document.getElementById('badge-earth');
const sunStatusText = document.getElementById('sun-status-text');
const earthStatusText = document.getElementById('earth-status-text');
const raycastAgreementText = document.getElementById('raycast-agreement-text');

const trackingBadge = document.getElementById('tracking-indicator-badge');
const trackingText = document.getElementById('tracking-indicator-text');

const batteryBarFill = document.getElementById('battery-bar-fill');
const batteryPctText = document.getElementById('battery-pct-text');
const dataProvenanceText = document.getElementById('data-provenance-text');

const failureBanner = document.getElementById('failure-banner');
const failureBannerText = document.getElementById('failure-banner-text');

const btnPlayPause = document.getElementById('btn-play-pause');
const btnStepBack = document.getElementById('btn-step-back');
const btnStepFwd = document.getElementById('btn-step-fwd');
const btnStepStart = document.getElementById('btn-step-start');
const btnStepEnd = document.getElementById('btn-step-end');
const speedSelector = document.getElementById('speed-selector');

const btnModeLander = document.getElementById('btn-mode-lander');
const btnModeOverview = document.getElementById('btn-mode-overview');

const btnMaskToggle = document.getElementById('btn-mask-toggle');

const btnLayerNone = document.getElementById('btn-layer-none');
const btnLayerSlope = document.getElementById('btn-layer-slope');
const btnLayerRock = document.getElementById('btn-layer-rock');
const legendSlope = document.getElementById('legend-slope');
const legendRock = document.getElementById('legend-rock');

const btnScale1x = document.getElementById('btn-scale-1x');
const btnScale3x = document.getElementById('btn-scale-3x');
const btnScale5x = document.getElementById('btn-scale-5x');

const btnLookSun = document.getElementById('btn-look-sun');
const btnLookEarth = document.getElementById('btn-look-earth');
const btnLookNorth = document.getElementById('btn-look-north');
const btnJumpFailure = document.getElementById('btn-jump-failure');
const windowStartInput = document.getElementById('window-start-input');
const windowEndInput = document.getElementById('window-end-input');
const delayInput = document.getElementById('delay-input');
const frameTicks = document.getElementById('frame-ticks');

// Initialize the 3D Lander Digital Twin Simulation
const sim = new LanderSimulation(container, (telemetry) => {
  // Update time and frame display
  timeSlider.value = telemetry.hourIndex;
  frameInput.value = telemetry.hourIndex;
  timeIsoText.textContent = telemetry.timestamp;
  sunCoordsText.textContent = `${telemetry.sunAz}°, ${telemetry.sunEl}°`;
  earthCoordsText.textContent = `${telemetry.earthAz}°, ${telemetry.earthEl}°`;

  // Update Tracking Lock Telemetry
  if (telemetry.trackingTarget === 'sun') {
    trackingBadge.style.display = 'flex';
    trackingText.textContent = 'TRACKING: SUN (LOCKED)';
    btnLookSun.classList.add('active');
    btnLookEarth.classList.remove('active');
  } else if (telemetry.trackingTarget === 'earth') {
    trackingBadge.style.display = 'flex';
    trackingText.textContent = 'TRACKING: EARTH (LOCKED)';
    btnLookEarth.classList.add('active');
    btnLookSun.classList.remove('active');
  } else {
    trackingBadge.style.display = 'none';
    btnLookSun.classList.remove('active');
    btnLookEarth.classList.remove('active');
  }

  // Mission window: slider / frame inputs follow it (no fixed hour counts).
  const win = telemetry.window;
  if (win && win.hours) {
    const lo = win.startIdx, hi = win.endIdx - 1;
    if (Number(timeSlider.min) !== lo || Number(timeSlider.max) !== hi) {
      timeSlider.min = lo; timeSlider.max = hi;
      frameInput.min = lo; frameInput.max = hi;
      windowStartInput.value = lo; windowEndInput.value = hi;
      frameTicks.innerHTML = Array.from({ length: 5 }, (_, k) =>
        `<span>${Math.round(lo + (k * (hi - lo)) / 4)}</span>`).join('');
    }
  }
  delayInput.value = telemetry.delayDays;

  // Battery (missionLogic.batteryTrace; scenario assumption, not NASA data). "—" outside the window.
  if (telemetry.landerState) {
    const soc = telemetry.landerState.socPct;
    batteryBarFill.style.width = `${soc}%`;
    batteryPctText.textContent = `${soc}%`;

    if (soc < 20) {
      batteryBarFill.style.backgroundColor = 'var(--blender-danger)';
    } else if (soc < 45) {
      batteryBarFill.style.backgroundColor = 'var(--blender-accent)';
    } else {
      batteryBarFill.style.backgroundColor = 'var(--blender-success)';
    }
  } else {
    batteryBarFill.style.width = '0%';
    batteryPctText.textContent = '—';
  }

  // Sun / Earth badges: engine flag, independent ray-cast result in brackets.
  const ray = (v) => (v ? 'ray: clear' : 'ray: blocked');
  badgeSun.className = `telemetry-box ${telemetry.sunLitEngine ? 'status-ok' : 'status-blocked'}`;
  sunStatusText.textContent = `SUN: ${telemetry.sunLitEngine ? 'OK' : 'BLOCKED'} (${ray(telemetry.sunLitRaycast)})`;
  badgeEarth.className = `telemetry-box ${telemetry.earthVisEngine ? 'status-ok' : 'status-blocked'}`;
  earthStatusText.textContent = `EARTH: ${telemetry.earthVisEngine ? 'OK' : 'BLOCKED'} (${ray(telemetry.earthVisRaycast)})`;

  // Ray-cast agreement: only computed results, never a typed-in number.
  const fmt = (r) => (!r ? 'computing…' : r.error ? 'error'
    : `${r.pct.toFixed(1)}% of ${r.checked} h${r.outOfGrid ? ` (+${r.outOfGrid} h beyond grid)` : ''}`);
  const ag = telemetry.agreement || {};
  raycastAgreementText.textContent = telemetry.isRealData
    ? `Sun ${fmt(ag.sun)} · Earth ${fmt(ag.earth)}`
    : `synthetic: Sun ${fmt(ag.sun)} · Earth ${fmt(ag.earth)}`;

  // Failure banner: text from missionLogic.failureMessage() on the engine flags.
  if (telemetry.failureEvent) {
    failureBanner.style.display = 'flex';
    failureBannerText.textContent = telemetry.failureEvent.message;
  } else {
    failureBanner.style.display = 'none';
  }

  // Data provenance label
  if (telemetry.isRealData) {
    dataProvenanceText.textContent =
      `DATA: NASA LOLA 5 m / 20 m terrain · JPL SPICE ephemeris (checked vs Horizons) · ${telemetry.siteName}`;
  } else {
    dataProvenanceText.textContent = `DATA: SYNTHETIC DEMO (data_out/ not found) · ${telemetry.siteId}`;
  }
});

// Set initial speed
sim.setSpeed(Number(speedSelector.value));

// Site list from data_out/sites.json (falls back to ids marked synthetic).
sim.dataLoader.loadSites().then(({ sites }) => {
  const current = siteSelector.value || 'site04';
  siteSelector.innerHTML = sites
    .map((s) => `<option value="${s.id}"${s.id === current ? ' selected' : ''}>${s.name}</option>`)
    .join('');
  sim.setHourIndex(sim.currentHourIndex);   // refresh names in labels/banner
  if (sim.dataset) sim.setDelayDays(sim.mission.delayDays);
});

// Site Switching
siteSelector.addEventListener('change', (e) => {
  sim.loadDataset(e.target.value);
});

// Play / Pause with SVG toggle
let isPlaying = false;
const playSvg = `
  <svg viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3"></polygon>
  </svg>
`;
const pauseSvg = `
  <svg viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16"></rect>
    <rect x="14" y="4" width="4" height="16"></rect>
  </svg>
`;

btnPlayPause.addEventListener('click', () => {
  isPlaying = !isPlaying;
  sim.setPlaying(isPlaying);
  btnPlayPause.innerHTML = isPlaying ? pauseSvg : playSvg;
  btnPlayPause.classList.toggle('play-active', isPlaying);
});

// Step Controls
btnStepBack.addEventListener('click', () => {
  sim.setHourIndex(sim.currentHourIndex - 1);
});
btnStepFwd.addEventListener('click', () => {
  sim.setHourIndex(sim.currentHourIndex + 1);
});
btnStepStart.addEventListener('click', () => {
  sim.setHourIndex(sim.dataset?.window?.startIdx ?? 0);
});
btnStepEnd.addEventListener('click', () => {
  const w = sim.dataset?.window;
  sim.setHourIndex(w && w.hours ? w.endIdx - 1 : 0);
});

// Launch delay (days): moves the mission window; failure and battery are recomputed.
delayInput.addEventListener('change', (e) => {
  sim.setDelayDays(Number(e.target.value));
});

// Timeline Scrubbing Slider
timeSlider.addEventListener('input', (e) => {
  const val = Number(e.target.value);
  frameInput.value = val;
  sim.setHourIndex(val);
});

// Numerical Frame Input
frameInput.addEventListener('change', (e) => {
  const val = Math.max(Number(timeSlider.min), Math.min(Number(timeSlider.max), Number(e.target.value) || 0));
  timeSlider.value = val;
  sim.setHourIndex(val);
});

// Speed Multiplier
speedSelector.addEventListener('change', (e) => {
  sim.setSpeed(Number(e.target.value));
});

// View Modes (Mode A: Lander First-Person vs Mode B: Orbital Overview)
btnModeLander.addEventListener('click', () => {
  btnModeLander.classList.add('active');
  btnModeOverview.classList.remove('active');
  sim.setViewMode('lander');
});

btnModeOverview.addEventListener('click', () => {
  btnModeOverview.classList.add('active');
  btnModeLander.classList.remove('active');
  sim.setViewMode('overview');
});

// Horizon Mask Line Overlay Toggle
let maskVisible = true;
btnMaskToggle.addEventListener('click', () => {
  maskVisible = !maskVisible;
  sim.horizon.setVisible(maskVisible);
  btnMaskToggle.classList.toggle('active', maskVisible);
});

// Terrain Data Layers
function setLayerActive(type) {
  btnLayerNone.classList.toggle('active', type === 'none');
  btnLayerSlope.classList.toggle('active', type === 'slope');
  btnLayerRock.classList.toggle('active', type === 'rock');

  legendSlope.style.display = type === 'slope' ? 'flex' : 'none';
  legendRock.style.display = type === 'rock' ? 'flex' : 'none';

  sim.terrain.setOverlay(type);
}
btnLayerNone.addEventListener('click', () => setLayerActive('none'));
btnLayerSlope.addEventListener('click', () => setLayerActive('slope'));
btnLayerRock.addEventListener('click', () => setLayerActive('rock'));

// Body Scale
function setScaleActive(mult, btn) {
  [btnScale1x, btnScale3x, btnScale5x].forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  sim.celestials.setExaggeration(mult);
}
btnScale1x.addEventListener('click', () => setScaleActive(1.0, btnScale1x));
btnScale3x.addEventListener('click', () => setScaleActive(3.0, btnScale3x));
btnScale5x.addEventListener('click', () => setScaleActive(5.0, btnScale5x));

// Camera Presets & Tracking Lock
btnLookSun.addEventListener('click', () => {
  sim.setTrackingTarget('sun');
});

btnLookEarth.addEventListener('click', () => {
  sim.setTrackingTarget('earth');
});

btnLookNorth.addEventListener('click', () => {
  sim.lookNorth();
});

// Jump to First Failure
btnJumpFailure.addEventListener('click', () => {
  sim.jumpToFirstFailure();
});
