import { LanderSimulation } from './simulation/LanderSimulation.js';
import { SouthPoleMap2D } from './simulation/SouthPoleMap2D.js';
import { evaluateCustomExpedition } from './core/nasaTrekApi.js';

// DOM Elements
const container = document.getElementById('simulation-container');
const map2dContainer = document.getElementById('map-2d-container');
const viewportModeSelect = document.getElementById('viewport-mode-select');
const toolsDock = document.querySelector('.blender-tools-dock');
const timeSlider = document.getElementById('time-slider');
const frameInput = document.getElementById('frame-input');
const timeIsoText = document.getElementById('time-iso-text');
const sunCoordsText = document.getElementById('sun-coords-text');
const earthCoordsText = document.getElementById('earth-coords-text');

let map2d = null;

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

const missionFailureWidget = document.getElementById('mission-failure-widget');
const popoverCategory = document.getElementById('popover-category-tag');
const popoverEpochTime = document.getElementById('popover-epoch-time');
const popoverShortReason = document.getElementById('popover-short-reason');

const failureDetailModal = document.getElementById('failure-detail-modal');
const btnCloseFailureModal = document.getElementById('btn-close-failure-modal');
const btnFailureJump3d = document.getElementById('btn-failure-jump-3d');
const btnFailureOpenPlanner = document.getElementById('btn-failure-open-planner');

let currentActiveFailure = null;

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
const totalHoursInput = document.getElementById('total-hours-input');
const delayInput = document.getElementById('delay-input');
const frameTicks = document.getElementById('frame-ticks');
const timelineExpeditionBadge = document.getElementById('timeline-expedition-badge');
const timelineExpRangeText = document.getElementById('timeline-exp-range-text');
const btnClearExpedition = document.getElementById('btn-clear-expedition');

const countdownText = document.getElementById('countdown-text');
const scaleWarningBadge = document.getElementById('scale-warning-badge');
const scaleWarningText = document.getElementById('scale-warning-text');
const walkWarningBadge = document.getElementById('walk-warning-badge');
const walkWarningText = document.getElementById('walk-warning-text');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingStatusText = document.getElementById('loading-status-text');

// Initialize the 3D Lander Digital Twin Simulation
const sim = new LanderSimulation(
  container,
  (telemetry) => {
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

    // Mission window: slider / frame inputs allow full-year scrubbing (0-8759) or shrink to expedition window.
    const win = telemetry.window;
    if (win && win.hours) {
      const totalMax = (telemetry.totalHours ? telemetry.totalHours - 1 : 8759);
      if (!sim.expeditionWindow) {
        if (Number(timeSlider.max) !== totalMax || Number(timeSlider.min) !== 0) {
          timeSlider.min = 0;
          timeSlider.max = totalMax;
          frameInput.min = 0;
          frameInput.max = totalMax;
          frameTicks.innerHTML = Array.from({ length: 5 }, (_, k) =>
            `<span>${Math.round((k * totalMax) / 4)}</span>`).join('');
        }
        windowStartInput.value = 0;
        windowEndInput.value = totalMax;
        if (timelineExpeditionBadge) timelineExpeditionBadge.style.display = 'none';
        const scrubberArea = document.querySelector('.timeline-scrubber-area');
        if (scrubberArea) scrubberArea.classList.remove('expedition-active');
      } else {
        const exp = sim.expeditionWindow;
        if (Number(timeSlider.min) !== exp.startIdx || Number(timeSlider.max) !== exp.endIdx) {
          timeSlider.min = exp.startIdx;
          timeSlider.max = exp.endIdx;
          frameInput.min = exp.startIdx;
          frameInput.max = exp.endIdx;
          const span = exp.endIdx - exp.startIdx;
          frameTicks.innerHTML = Array.from({ length: 5 }, (_, k) =>
            `<span>${Math.round(exp.startIdx + (k * span) / 4)}</span>`).join('');
        }
        windowStartInput.value = exp.startIdx;
        windowEndInput.value = exp.endIdx;
        if (timelineExpeditionBadge) {
          timelineExpeditionBadge.style.display = 'flex';
          if (timelineExpRangeText && exp.startDate && exp.endDate) {
            timelineExpRangeText.textContent = `${exp.startDate} – ${exp.endDate} (${exp.endIdx - exp.startIdx} h)`;
          }
        }
        const scrubberArea = document.querySelector('.timeline-scrubber-area');
        if (scrubberArea) scrubberArea.classList.add('expedition-active');
      }
      if (totalHoursInput) totalHoursInput.value = sim.expeditionWindow ? (sim.expeditionWindow.endIdx - sim.expeditionWindow.startIdx) : totalMax;
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

    // Sun / Earth status badges: unblocked / blocked with independent raycast in brackets
    const rayS = telemetry.sunLitRaycast ? 'clear' : 'blocked';
    const rayE = telemetry.earthVisRaycast ? 'clear' : 'blocked';
    badgeSun.className = `telemetry-box ${telemetry.sunLitEngine ? 'status-ok' : 'status-blocked'}`;
    sunStatusText.textContent = `SUN: ${telemetry.sunLitEngine ? 'UNBLOCKED' : 'BLOCKED'} (${rayS})`;
    badgeEarth.className = `telemetry-box ${telemetry.earthVisEngine ? 'status-ok' : 'status-blocked'}`;
    earthStatusText.textContent = `EARTH: ${telemetry.earthVisEngine ? 'UNBLOCKED' : 'BLOCKED'} (${rayE})`;

    // M4.2 Real-time Countdowns in HUD (compact, regular font)
    if (countdownText) {
      countdownText.textContent = `${telemetry.nextSunEvent || '—'} · ${telemetry.nextEarthEvent || '—'}`;
    }

    // M4.3 Walk Distance Warning
    if (walkWarningBadge && walkWarningText) {
      if (telemetry.walkDistM > 50) {
        walkWarningBadge.style.display = 'flex';
        walkWarningText.textContent = `Mask line is for lander position (${telemetry.walkDistM} m away)`;
      } else {
        walkWarningBadge.style.display = 'none';
      }
    }

    // Pass telemetry to 2D Map
    if (typeof map2d !== 'undefined' && map2d) {
      map2d.updateEphemeris(telemetry);
    }

    // Ray-cast agreement: clean, compact regular font
    if (!telemetry.agreement || !telemetry.agreement.sun) {
      raycastAgreementText.textContent = telemetry.isRealData && !telemetry.isMoonTrekApi
        ? 'computing…'
        : '—';
    } else {
      const fmt = (r) => (!r ? '—' : r.error ? 'err' : `${r.pct.toFixed(0)}%`);
      const ag = telemetry.agreement;
      raycastAgreementText.textContent = `Sun ${fmt(ag.sun)} · Earth ${fmt(ag.earth)}`;
    }

    // Mission Failure Warning Icon Widget (in header between Expedition Planner and Battery)
    if (telemetry.failureEvent) {
      const f = telemetry.failureEvent;
      currentActiveFailure = f;
      if (missionFailureWidget) {
        missionFailureWidget.style.display = 'flex';
        missionFailureWidget.classList.add('is-failed');
      }

      let category = 'MISSION CONSTRAINT BREACH';
      let shortReason = f.message || 'Mission constraint violated.';
      if (f.kind === 'comm') {
        category = 'COMMUNICATION CUT WITH EARTH';
        shortReason = `Earth direct line-of-sight lost for >24 h. Communication blackout reached ${f.durationHours || f.runH || 25} consecutive hours.`;
      } else if (f.kind === 'night') {
        category = 'VOID OF SUNLIGHT';
        shortReason = `Surface in total darkness / void of sunlight for >36 h. Lunar night reached ${f.durationHours || f.runH || 37} consecutive hours.`;
      } else if (f.kind === 'battery') {
        category = 'BATTERY DEPLETION';
        shortReason = `Spacecraft battery storage depleted to 0 Wh after extended shadow period.`;
      } else if (f.kind === 'sun_pct') {
        category = 'INSUFFICIENT SUNLIGHT';
        shortReason = `Total sunlight illumination is ${f.value || 0}%, below the required 40.0% solar budget.`;
      }

      if (popoverCategory) popoverCategory.textContent = category;
      if (popoverEpochTime) popoverEpochTime.textContent = telemetry.timestamp ? telemetry.timestamp.slice(5, 16) + ' UTC' : `Hour ${f.hourIndex}`;
      if (popoverShortReason) popoverShortReason.textContent = shortReason;
    } else {
      currentActiveFailure = null;
      if (missionFailureWidget) {
        missionFailureWidget.style.display = 'none';
        missionFailureWidget.classList.remove('is-failed');
      }
    }

    // Data provenance label
    if (telemetry.isMoonTrekApi) {
      dataProvenanceText.textContent =
        `DATA: NASA MOON TREK REST API (LOLA DEM 20m) · ${telemetry.siteName}`;
    } else if (telemetry.isRealData) {
      dataProvenanceText.textContent =
        `DATA: NASA LOLA 5 m / 20 m terrain · JPL SPICE ephemeris (checked vs Horizons) · ${telemetry.siteName}`;
    } else {
      dataProvenanceText.textContent = `DATA: SYNTHETIC DEMO (data_out/ not found) · ${telemetry.siteId}`;
    }
  },
  (isLoading, message) => {
    if (loadingOverlay) {
      loadingOverlay.style.display = isLoading ? 'flex' : 'none';
      if (loadingStatusText && message) loadingStatusText.textContent = message;
    }
  }
);

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
  sim.setHourIndex(sim.expeditionWindow ? sim.expeditionWindow.startIdx : 0);
});
btnStepEnd.addEventListener('click', () => {
  const totalMax = sim.dataset?.totalHours ? sim.dataset.totalHours - 1 : 8759;
  sim.setHourIndex(sim.expeditionWindow ? sim.expeditionWindow.endIdx : totalMax);
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

  if (scaleWarningBadge && scaleWarningText) {
    if (mult > 1.0) {
      scaleWarningBadge.style.display = 'flex';
      scaleWarningText.textContent = `Sun/Earth enlarged ×${mult} for visibility (true angular sizes 0.53° / 1.9°)`;
    } else {
      scaleWarningBadge.style.display = 'none';
    }
  }
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

// -------------------------------------------------------------
// 2D South Pole Navigator & Viewport Mode Dropdown
// -------------------------------------------------------------
map2d = new SouthPoleMap2D(map2dContainer, (target) => {
  // Teleport from 2D map into 3D Simulation Viewport
  setViewportMode('3d');
  if (target.isCandidateSite && target.siteId) {
    siteSelector.value = target.siteId;
    sim.loadDataset(target.siteId);
  } else {
    // Add or select custom sector option
    let customOpt = siteSelector.querySelector('option[value="custom"]');
    if (!customOpt) {
      customOpt = document.createElement('option');
      customOpt.value = 'custom';
      siteSelector.appendChild(customOpt);
    }
    customOpt.textContent = target.name || `Sector ${target.sectorId}`;
    customOpt.selected = true;
    siteSelector.value = 'custom';

    sim.loadCustomChunk(target);
  }
});

function setViewportMode(mode) {
  const is3D = mode === '3d';
  container.style.display = is3D ? 'block' : 'none';
  if (is3D) {
    map2dContainer.classList.remove('active');
    map2dContainer.style.display = 'none';
    map2dContainer.style.pointerEvents = 'none';
    map2d.setVisible(false);
    if (document.activeElement) document.activeElement.blur();
    window.focus();
  } else {
    map2dContainer.classList.add('active');
    map2dContainer.style.display = 'block';
    map2dContainer.style.pointerEvents = 'auto';
    map2d.setVisible(true);
  }
  if (toolsDock) toolsDock.style.display = is3D ? 'flex' : 'none';
  if (viewportModeSelect) viewportModeSelect.value = mode;
}

if (viewportModeSelect) {
  viewportModeSelect.addEventListener('change', (e) => {
    setViewportMode(e.target.value);
  });
}

// -------------------------------------------------------------
// Blender-Style Expedition Feasibility Planner
// -------------------------------------------------------------
const btnExpeditionPlanner = document.getElementById('btn-expedition-planner');
const expeditionModal = document.getElementById('expedition-modal');
const btnCloseExpedition = document.getElementById('btn-close-expedition');
const expStartDateInput = document.getElementById('exp-start-date');
const expEndDateInput = document.getElementById('exp-end-date');
const btnRunExpedition = document.getElementById('btn-run-expedition-calc');
const btnApplyExpedition = document.getElementById('btn-apply-expedition-timeline');
const expStatusBadge = document.getElementById('exp-status-badge');
const expSiteName = document.getElementById('exp-site-name');
const expFailureReason = document.getElementById('exp-failure-reason');
const expMetricDuration = document.getElementById('exp-metric-duration');
const expMetricSun = document.getElementById('exp-metric-sun');
const expMetricEarth = document.getElementById('exp-metric-earth');
const expMetricNight = document.getElementById('exp-metric-night');
const expMetricGap = document.getElementById('exp-metric-gap');
const expMetricBattery = document.getElementById('exp-metric-battery');
const presetChips = document.querySelectorAll('.preset-chip');

// Hour-to-hour ribbon and detailed analysis elements
const expHourlyStrip = document.getElementById('exp-hourly-strip');
const expStripHoverInfo = document.getElementById('exp-strip-hover-info');
const expDetailEarth = document.getElementById('exp-detail-earth');
const expDetailSun = document.getElementById('exp-detail-sun');
const expDetailVerdict = document.getElementById('exp-detail-verdict');

let currentExpeditionResult = null;

if (btnExpeditionPlanner && expeditionModal) {
  btnExpeditionPlanner.addEventListener('click', () => {
    expeditionModal.style.display = 'flex';
    runExpeditionCalculation();
  });
}

if (btnCloseExpedition && expeditionModal) {
  btnCloseExpedition.addEventListener('click', () => {
    expeditionModal.style.display = 'none';
  });
}

if (expeditionModal) {
  expeditionModal.addEventListener('click', (e) => {
    if (e.target === expeditionModal) {
      expeditionModal.style.display = 'none';
    }
  });
}

// Preset duration chips
presetChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    presetChips.forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    const days = parseInt(chip.getAttribute('data-days'), 10) || 14;
    const start = new Date((expStartDateInput.value || '2027-01-09') + 'T00:00:00Z');
    const end = new Date(start.getTime() + days * 86400000);
    expEndDateInput.value = end.toISOString().split('T')[0];
    runExpeditionCalculation();
  });
});

if (expStartDateInput) {
  expStartDateInput.addEventListener('change', () => runExpeditionCalculation());
}
if (expEndDateInput) {
  expEndDateInput.addEventListener('change', () => runExpeditionCalculation());
}

if (btnRunExpedition) {
  btnRunExpedition.addEventListener('click', () => runExpeditionCalculation());
}

/**
 * Draws the high-resolution hour-by-hour visual profile ribbon
 */
function drawExpeditionRibbon(result) {
  if (!expHourlyStrip || !result) return;
  const canvas = expHourlyStrip;
  const W = canvas.clientWidth || 620;
  const H = 54;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Background
  ctx.fillStyle = 'rgba(10, 15, 24, 0.95)';
  ctx.fillRect(0, 0, W, H);

  const n = result.totalHours;
  if (!n || n <= 0) return;

  // Draw 3 horizontal stripes across the time duration:
  // Row 1: Sun illumination (y: 2, height: 15)
  // Row 2: Earth direct contact (y: 19, height: 15)
  // Row 3: Battery SoC (y: 36, height: 15)
  for (let px = 0; px < W; px++) {
    const a = Math.floor((px / W) * n);
    const b = Math.max(a + 1, Math.floor(((px + 1) / W) * n));

    let sunSum = 0;
    let earthSum = 0;
    let batSum = 0;
    const count = b - a;

    for (let k = a; k < b; k++) {
      sunSum += result.hourlySun[k] || 0;
      earthSum += result.hourlyEarth[k] || 0;
      batSum += (result.hourlyBattery[k] || 0) / 1500.0;
    }

    const fs = sunSum / count;
    const fe = earthSum / count;
    const fb = Math.max(0, Math.min(1, batSum / count));

    // Sun: gold/amber when lit, dark indigo/slate when dark
    ctx.fillStyle = fs > 0.5 ? 'rgba(250, 204, 21, 0.92)' : 'rgba(30, 41, 59, 0.65)';
    ctx.fillRect(px, 2, 1, 15);

    // Earth: cyan/blue when in direct line-of-sight, dark crimson when blackout
    ctx.fillStyle = fe > 0.5 ? 'rgba(56, 189, 248, 0.92)' : 'rgba(185, 28, 28, 0.7)';
    ctx.fillRect(px, 19, 1, 15);

    // Battery: green height bar
    ctx.fillStyle = 'rgba(20, 30, 20, 0.8)';
    ctx.fillRect(px, 36, 1, 15);
    const barH = Math.max(1, Math.round(15 * fb));
    ctx.fillStyle = fb < 0.2 ? 'rgba(239, 68, 68, 0.9)' : fb < 0.45 ? 'rgba(245, 158, 11, 0.9)' : 'rgba(74, 222, 128, 0.9)';
    ctx.fillRect(px, 36 + (15 - barH), 1, barH);
  }

  // Draw dividers
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(0, 18, W, 1);
  ctx.fillRect(0, 35, W, 1);

  // If there's a failure, mark the exact failure hour with a glowing red vertical needle
  if (result.firstFailure) {
    const failIdx = result.firstFailure.hourIndex - result.startHour;
    if (failIdx >= 0 && failIdx < n) {
      const fx = Math.round((failIdx / n) * W);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(fx - 1, 0, 2, H);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.35)';
      ctx.fillRect(fx - 3, 0, 6, H);
    }
  }
}

// Hover inspection on the ribbon
if (expHourlyStrip) {
  expHourlyStrip.addEventListener('mousemove', (e) => {
    if (!currentExpeditionResult || !expStripHoverInfo) return;
    const rect = expHourlyStrip.getBoundingClientRect();
    const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const idx = Math.min(currentExpeditionResult.totalHours - 1, Math.floor(relX * currentExpeditionResult.totalHours));
    const h = currentExpeditionResult.startHour + idx;
    const ts = currentExpeditionResult.hourlyTimestamps[idx] || '';
    const isLit = currentExpeditionResult.hourlySun[idx] === 1;
    const isVis = currentExpeditionResult.hourlyEarth[idx] === 1;
    const batWh = Math.round(currentExpeditionResult.hourlyBattery[idx]);
    const batPct = Math.round((batWh * 100) / 1500);

    expStripHoverInfo.innerHTML = `<b>Hour ${h}</b> (${ts} UTC) · Sun: <span class="${isLit ? 'highlight-sun' : ''}">${isLit ? '☀️ LIT' : '🌑 SHADOW'}</span> · Earth: <span class="${isVis ? 'highlight-earth' : 'highlight-bat'}">${isVis ? '📡 IN CONTACT' : '⚠️ BLACKOUT'}</span> · Battery: ${batPct}% (${batWh} Wh)`;
  });

  expHourlyStrip.addEventListener('mouseleave', () => {
    if (expStripHoverInfo) {
      expStripHoverInfo.textContent = 'Hover across ribbon for exact hourly ephemeris & contact readout';
    }
  });
}

function runExpeditionCalculation() {
  if (!expStartDateInput || !expEndDateInput) return;
  const startDate = expStartDateInput.value;
  const endDate = expEndDateInput.value;
  if (!startDate || !endDate) return;

  const siteId = sim.currentSiteId || 'site04';
  const siteName = sim.dataset?.siteName || siteId;
  const lat = sim.customCoordinates?.lat || -89.76;
  const lon = sim.customCoordinates?.lon || 180.0;

  if (expSiteName) expSiteName.textContent = siteName;

  const result = evaluateCustomExpedition({
    siteId,
    lat,
    lon,
    startDate,
    endDate,
    dataset: sim.dataset,
    horizon: sim.horizon,
  });

  currentExpeditionResult = result;

  // Clear numerical & metric outputs
  if (expMetricDuration) expMetricDuration.textContent = `${result.durationDays} Days (${result.totalHours} h)`;
  if (expMetricSun) expMetricSun.textContent = `${result.sunHours} h / ${result.totalHours} h (${result.sunPct}%)`;
  if (expMetricEarth) expMetricEarth.textContent = `${result.earthHours} h / ${result.totalHours} h (${result.earthPct}%)`;
  if (expMetricNight) expMetricNight.textContent = `${result.maxNightHours} h (Limit: 36 h)`;
  if (expMetricGap) expMetricGap.textContent = `${result.maxCommGapHours} h (Limit: 24 h)`;
  if (expMetricBattery) expMetricBattery.textContent = `${result.minSocPct}% (${result.minBatteryWh} Wh)`;

  // Draw the hour-by-hour visual profile ribbon
  drawExpeditionRibbon(result);

  // Hour-by-hour Earth line-of-sight description
  if (expDetailEarth) {
    const isEarthOk = result.criteria.earthComm.passed;
    expDetailEarth.innerHTML = `Line-of-sight direct contact with Earth is maintained for <b>${result.earthHours} h</b> out of ${result.totalHours} h (<b>${result.earthPct}%</b>). Blackout intervals total ${result.blackoutHours} h across ${result.blackoutIntervals} event(s). Longest continuous blackout lasts <b>${result.maxCommGapHours} h</b> (${isEarthOk ? '<span style="color:#4ade80">✓ meets ≤24 h Artemis constraint</span>' : '<span style="color:#f87171">✗ EXCEEDS 24 h threshold</span>'}). Longest uninterrupted contact is <b>${result.maxContinuousConn} h</b>.`;
  }

  // Hour-by-hour Solar illumination description
  if (expDetailSun) {
    expDetailSun.innerHTML = `Direct solar illumination received for <b>${result.sunHours} h</b> (<b>${result.sunPct}%</b>, minimum required: 40%). Longest uninterrupted night is <b>${result.maxNightHours} h</b> (${result.criteria.thermalNight.passed ? '<span style="color:#4ade80">✓ meets ≤36 h thermal limit</span>' : '<span style="color:#f87171">✗ EXCEEDS 36 h limit</span>'}). Longest continuous sunlit period is <b>${result.maxContinuousLit} h</b>.`;
  }

  // Final Decision breakdown
  if (expDetailVerdict) {
    if (result.passed) {
      expDetailVerdict.innerHTML = `<span style="color:#4ade80;font-weight:700;">✓ MISSION APPROVED (GO):</span> All Artemis survival constraints satisfied. Comm blackout ≤ 24 h, night period ≤ 36 h, solar fraction ≥ 40%, and battery SoC sustains lander systems throughout (minimum: ${result.minSocPct}% / ${result.minBatteryWh} Wh).`;
    } else {
      expDetailVerdict.innerHTML = `<span style="color:#f87171;font-weight:700;">✗ MISSION REJECTED (NO-GO):</span> ${result.failReason}`;
    }
  }

  // Status Badge and Failure Reason
  if (expStatusBadge) {
    if (result.passed) {
      expStatusBadge.className = 'exp-badge badge-pass';
      expStatusBadge.textContent = 'EXPEDITION: FEASIBLE (GO)';
      if (expFailureReason) expFailureReason.style.display = 'none';
    } else {
      expStatusBadge.className = 'exp-badge badge-fail';
      expStatusBadge.textContent = 'EXPEDITION: INFEASIBLE (NO-GO)';
      if (expFailureReason) {
        expFailureReason.textContent = `CRITICAL FAILURE DETECTED: ${result.failReason}`;
        expFailureReason.style.display = 'block';
      }
    }
  }
}

if (btnApplyExpedition) {
  btnApplyExpedition.addEventListener('click', () => {
    if (!currentExpeditionResult) return;
    const startHour = currentExpeditionResult.startHour;
    const endHour = currentExpeditionResult.endHour;
    const startStr = expStartDateInput.value;
    const endStr = expEndDateInput.value;

    sim.setExpeditionWindow(startHour, endHour, startStr, endStr);

    timeSlider.min = startHour;
    timeSlider.max = endHour;
    frameInput.min = startHour;
    frameInput.max = endHour;
    windowStartInput.value = startHour;
    windowEndInput.value = endHour;

    const span = endHour - startHour;
    frameTicks.innerHTML = Array.from({ length: 5 }, (_, k) =>
      `<span>${Math.round(startHour + (k * span) / 4)}</span>`).join('');

    if (timelineExpeditionBadge) {
      timelineExpeditionBadge.style.display = 'flex';
      if (timelineExpRangeText) {
        timelineExpRangeText.textContent = `${startStr} – ${endStr} (${span} h)`;
      }
    }
    const scrubberArea = document.querySelector('.timeline-scrubber-area');
    if (scrubberArea) scrubberArea.classList.add('expedition-active');

    if (expeditionModal) expeditionModal.style.display = 'none';
    sim.setHourIndex(startHour);
  });
}

if (btnClearExpedition) {
  btnClearExpedition.addEventListener('click', () => {
    sim.clearExpeditionWindow();
    const totalMax = sim.dataset?.totalHours ? sim.dataset.totalHours - 1 : 8759;
    timeSlider.min = 0;
    timeSlider.max = totalMax;
    frameInput.min = 0;
    frameInput.max = totalMax;
    windowStartInput.value = 0;
    windowEndInput.value = totalMax;
    frameTicks.innerHTML = Array.from({ length: 5 }, (_, k) =>
      `<span>${Math.round((k * totalMax) / 4)}</span>`).join('');

    if (timelineExpeditionBadge) timelineExpeditionBadge.style.display = 'none';
    const scrubberArea = document.querySelector('.timeline-scrubber-area');
    if (scrubberArea) scrubberArea.classList.remove('expedition-active');
  });
}

// -------------------------------------------------------------
// Detailed Mission Failure Root Cause Analysis Modal
// -------------------------------------------------------------
function openFailureDetailModal() {
  const f = currentActiveFailure || sim.dataset?.firstFailure;
  if (!f || !failureDetailModal) return;

  const failureDetailKind = document.getElementById('failure-detail-kind');
  const failureDetailEpoch = document.getElementById('failure-detail-epoch');
  const failureDetailHeadline = document.getElementById('failure-detail-headline');
  const diagConstraint = document.getElementById('diag-constraint');
  const diagRun = document.getElementById('diag-run');
  const diagAz = document.getElementById('diag-az');
  const diagBat = document.getElementById('diag-bat');
  const diagNarrative = document.getElementById('diag-narrative');

  const ts = f.timestamp || (sim.dataset?.timestamps ? sim.dataset.timestamps[f.hourIndex] : '2027');
  const epochStr = `Mission Hour ${f.hourIndex + 1} (${ts} UTC)`;
  if (failureDetailEpoch) failureDetailEpoch.textContent = epochStr;

  const site = sim.dataset?.siteName || sim.currentSiteId || 'Candidate Site';

  if (f.kind === 'comm') {
    if (failureDetailKind) failureDetailKind.textContent = 'COMMUNICATION CUT WITH EARTH';
    if (failureDetailHeadline) failureDetailHeadline.textContent = `Earth direct line-of-sight communication blackout reached ${f.durationHours || f.runH || 25} consecutive hours (limit: 24 h).`;
    if (diagConstraint) diagConstraint.textContent = 'Earth Line-of-Sight Blackout ≤ 24 h';
    if (diagRun) diagRun.textContent = `${f.durationHours || f.runH || 25} h (Artemis Limit: 24 h)`;
    if (diagAz) diagAz.textContent = f.blockingAz ? `${f.blockingAz.toFixed(1)}° (Crater Rim Obstacle)` : 'Horizon Topography';
    if (diagNarrative) {
      diagNarrative.textContent = `At ${site}, the Earth drops below the local crater horizon at ${ts}. Direct line-of-sight radio link back to Earth ground stations is severed for ${f.durationHours || f.runH || 25} continuous hours, exceeding the Artemis 24-hour limit. To maintain crew safety and real-time telemetry, landing dates must be shifted or an orbital relay satellite (e.g. Gateway) must be scheduled.`;
    }
  } else if (f.kind === 'night') {
    if (failureDetailKind) failureDetailKind.textContent = 'VOID OF SUNLIGHT (LUNAR NIGHT)';
    if (failureDetailHeadline) failureDetailHeadline.textContent = `Continuous darkness / void of sunlight reached ${f.durationHours || f.runH || 37} consecutive hours (thermal limit: 36 h).`;
    if (diagConstraint) diagConstraint.textContent = 'Continuous Darkness / Night ≤ 36 h';
    if (diagRun) diagRun.textContent = `${f.durationHours || f.runH || 37} h (Thermal Limit: 36 h)`;
    if (diagAz) diagAz.textContent = f.blockingAz ? `${f.blockingAz.toFixed(1)}° (Solar Horizon)` : 'Crater Rim Shadow';
    if (diagNarrative) {
      diagNarrative.textContent = `At ${site}, low solar elevation angles cast extended shadows that plunge the lander into continuous darkness for ${f.durationHours || f.runH || 37} hours. Without solar illumination, spacecraft temperatures drop below cryogenic survival thresholds and solar arrays produce zero electrical power.`;
    }
  } else if (f.kind === 'battery') {
    if (failureDetailKind) failureDetailKind.textContent = 'BATTERY STORAGE DEPLETION';
    if (failureDetailHeadline) failureDetailHeadline.textContent = `Spacecraft energy storage reached 0 Wh (1500 Wh battery capacity exhausted during extended shadow).`;
    if (diagConstraint) diagConstraint.textContent = 'Battery State of Charge > 0%';
    if (diagRun) diagRun.textContent = `0 Wh / 0% SoC`;
    if (diagAz) diagAz.textContent = 'Prolonged Shadow Period';
    if (diagNarrative) {
      diagNarrative.textContent = `The lander battery (1500 Wh capacity, 80 W baseload) was fully drained after prolonged solar occlusion. Avionics and life support heaters cannot sustain operation without active power generation or expanded battery capacity.`;
    }
  } else if (f.kind === 'sun_pct') {
    if (failureDetailKind) failureDetailKind.textContent = 'INSUFFICIENT SOLAR BUDGET';
    if (failureDetailHeadline) failureDetailHeadline.textContent = `Total cumulative solar illumination fell below the minimum Artemis 40.0% requirement.`;
    if (diagConstraint) diagConstraint.textContent = 'Sunlit Percentage ≥ 40.0%';
    if (diagRun) diagRun.textContent = `${f.value || 0}% (Required: ≥ 40.0%)`;
    if (diagAz) diagAz.textContent = 'Topographic Shadowing';
    if (diagNarrative) {
      diagNarrative.textContent = `Cumulative solar illumination at this site across the mission window is only ${f.value || 0}%, failing the Artemis 40% energy threshold needed for solar recharging and surface exploration activities.`;
    }
  }

  // Battery status at failure hour
  if (diagBat) {
    if (sim.dataset?.battery && sim.dataset?.window) {
      const idx = f.hourIndex - sim.dataset.window.startIdx;
      if (idx >= 0 && idx < sim.dataset.battery.socWh.length) {
        const wh = Math.round(sim.dataset.battery.socWh[idx]);
        const pct = Math.round((100 * wh) / 1500);
        diagBat.textContent = `${pct}% (${wh} Wh)`;
      } else {
        diagBat.textContent = '—';
      }
    } else {
      diagBat.textContent = '—';
    }
  }

  failureDetailModal.style.display = 'flex';
}

if (missionFailureWidget) {
  missionFailureWidget.addEventListener('click', () => {
    openFailureDetailModal();
  });
}

if (btnCloseFailureModal && failureDetailModal) {
  btnCloseFailureModal.addEventListener('click', () => {
    failureDetailModal.style.display = 'none';
  });
}

if (failureDetailModal) {
  failureDetailModal.addEventListener('click', (e) => {
    if (e.target === failureDetailModal) {
      failureDetailModal.style.display = 'none';
    }
  });
}

if (btnFailureJump3d) {
  btnFailureJump3d.addEventListener('click', () => {
    if (failureDetailModal) failureDetailModal.style.display = 'none';
    sim.jumpToFirstFailure();
  });
}

if (btnFailureOpenPlanner) {
  btnFailureOpenPlanner.addEventListener('click', () => {
    if (failureDetailModal) failureDetailModal.style.display = 'none';
    if (expeditionModal) {
      expeditionModal.style.display = 'flex';
      runExpeditionCalculation();
    }
  });
}

