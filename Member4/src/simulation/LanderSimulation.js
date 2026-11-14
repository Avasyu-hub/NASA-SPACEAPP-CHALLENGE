import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TerrainMesh } from './TerrainMesh.js';
import { CelestialBodies } from './CelestialBodies.js';
import { HorizonOverlay } from './HorizonOverlay.js';
import { CompassGrid } from './CompassGrid.js';
import { generateFakeDataset, testRaycast } from '../core/fakeData.js';
import { DataLoader } from '../core/dataLoader.js';
import { bodyDirection } from '../core/math.js';
// One implementation of the mission rules, shared with the dashboard (M1, web/src/core).
import { evaluate, failureMessage, batteryTrace } from '../../../web/src/core/missionLogic.js';

// Mission defaults (goal.md 8.1 / 8.2 examples, addendum section 6). User inputs, not NASA values.
const DEFAULT_MISSION = { delayDays: 0, durationDays: 14 };
const DEFAULT_REQUIREMENTS = {
  minSunPct: 40,
  maxNightH: 36,
  maxCommGapH: 24,
  battery: { capacityWh: 1500, solarW: 250, loadW: 80 },   // scenario assumption, not NASA data
};

/**
 * LunaWise Lander Digital Twin Simulation
 * Coordinates Three.js rendering, Mode A (WASD Surface Traverse),
 * Mode B (Overview with solid pedestal), Mode C (Replay / Failure Exploration),
 * Off-thread Web Worker Raycasting, and Continuous Sun/Earth Tracking Lock.
 */
export class LanderSimulation {
  constructor(containerElement, onTelemetryUpdate) {
    this.container = containerElement;
    this.onTelemetryUpdate = onTelemetryUpdate || (() => {});

    this.mode = 'lander'; // 'lander' (Mode A) | 'overview' (Mode B)
    this.currentHourIndex = 0;
    this.isPlaying = false;
    this.playbackSpeed = 10;
    this.lastTickTime = performance.now();
    this.lastFrameTime = performance.now();

    // Mode A Camera Look State
    this.yaw = 0.0;
    this.pitch = 0.04;
    this.isDragging = false;
    this.prevMouseX = 0;
    this.prevMouseY = 0;

    // Mode A WASD Surface Walking Position
    this.landerX = 0.0;
    this.landerZ = 0.0;
    this.moveSpeed = 18.0; // meters per second
    this.keys = {
      KeyW: false,
      KeyA: false,
      KeyS: false,
      KeyD: false,
      ShiftLeft: false,
      ShiftRight: false,
    };

    // Smooth transition & continuous tracking lock state
    this.targetYaw = null;
    this.targetPitch = null;
    this.trackingTarget = null; // 'sun' | 'earth' | null

    this.dataLoader = new DataLoader();
    this.mission = { ...DEFAULT_MISSION };
    this.requirements = { ...DEFAULT_REQUIREMENTS };
    this.rayWorkers = null;
    this.agreement = { sun: null, earth: null };   // filled only by computed results
    this.currentSiteId = 'site04';

    this.initScene();
    this.initSubsystems();
    this.initControls();
    this.initRaycastWorker();
    this.loadDataset(this.currentSiteId);

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020408);

    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(72, width / height, 0.1, 250000);
    this.camera.position.set(0, 2.0, 0);
    this.camera.rotation.order = 'YXZ';

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.container.appendChild(this.renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0x0e141e, 0.45);
    this.ambientLight = ambientLight;
    this.scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0x1a2638, 0x05070a, 0.30);
    this.hemiLight = hemiLight;
    this.scene.add(hemiLight);

    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.05;
    this.orbitControls.maxDistance = 35000;
    this.orbitControls.minDistance = 50;
    this.orbitControls.maxPolarAngle = Math.PI / 2 - 0.01;
    this.orbitControls.enabled = false;

    window.addEventListener('resize', () => this.onResize());
  }

  initSubsystems() {
    this.terrain = new TerrainMesh(this.scene);
    this.terrain.generateProceduralTerrain('site04');

    this.celestials = new CelestialBodies(this.scene);

    this.horizon = new HorizonOverlay(this.scene);
    this.horizon.generateProceduralMask(this.terrain);

    this.compass = new CompassGrid(this.scene);
  }

  initControls() {
    const dom = this.renderer.domElement;

    // Pointer events for Mode A look-around
    dom.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'lander') return;
      this.isDragging = true;
      this.prevMouseX = e.clientX;
      this.prevMouseY = e.clientY;
      // User manual mouse look disengages tracking lock
      this.trackingTarget = null;
      this.targetYaw = null;
      this.targetPitch = null;
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.isDragging || this.mode !== 'lander') return;

      const deltaX = e.clientX - this.prevMouseX;
      const deltaY = e.clientY - this.prevMouseY;

      this.prevMouseX = e.clientX;
      this.prevMouseY = e.clientY;

      const sensitivity = 0.0024;
      this.yaw -= deltaX * sensitivity;
      this.pitch -= deltaY * sensitivity;

      const minPitch = (-15 * Math.PI) / 180;
      const maxPitch = (55 * Math.PI) / 180;
      this.pitch = Math.max(minPitch, Math.min(maxPitch, this.pitch));
    });

    window.addEventListener('pointerup', () => {
      this.isDragging = false;
    });

    // Double-click canvas to toggle tracking lock
    dom.addEventListener('dblclick', () => {
      if (this.trackingTarget === 'sun') {
        this.setTrackingTarget('earth');
      } else if (this.trackingTarget === 'earth') {
        this.setTrackingTarget(null);
      } else {
        this.setTrackingTarget('sun');
      }
    });

    // WASD Keyboard Surface Walking
    window.addEventListener('keydown', (e) => {
      if (e.code in this.keys) {
        this.keys[e.code] = true;
        this.trackingTarget = null; // User moving breaks tracking lock
      }
      if (e.code === 'KeyR') {
        this.resetLanderPosition();
      }
      if (e.code === 'Space') {
        e.preventDefault();
        this.setPlaying(!this.isPlaying);
      }
      if (e.code === 'Escape') {
        this.setTrackingTarget(null);
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code in this.keys) {
        this.keys[e.code] = false;
      }
    });
  }

  /**
   * M2's ray-cast agreement worker (Member2/src/raycastWorker.js), one per body: a reply does not
   * say which body it is for, and replies can arrive in any order. It skips hours whose blocking
   * terrain lies beyond the 30.7 km heightmap (the engine searches 200 km) and reports them as
   * outOfGrid, so the percentage is over hours the ray cast can actually check.
   */
  initRaycastWorker() {
    try {
      this.rayWorkers = {};
      for (const body of ['sun', 'earth']) {
        // Keep new URL(...) inline in new Worker(...): that is the pattern Vite bundles.
        const w = new Worker(new URL('../../../Member2/src/raycastWorker.js', import.meta.url),
                             { type: 'module' });
        w.onmessage = ({ data }) => {
          if (data.siteId !== this.currentSiteId || !this.dataset?.isRealData) return; // stale
          this.agreement[body] = data;     // { pct, checked, outOfGrid, ... } or { error }
          this.setHourIndex(this.currentHourIndex);
        };
        this.rayWorkers[body] = w;
      }
    } catch (err) {
      console.warn('[LanderSimulation] ray-cast worker unavailable; agreement not shown.', err);
      this.rayWorkers = null;
    }
  }

  siteName(id) {
    const s = (this.dataLoader.availableSites || []).find((x) => x.id === id);
    return s ? s.name : id;
  }

  /**
   * Mission window, first failure and battery for the current dataset, all from missionLogic.js
   * (same functions as the dashboard). Nothing here is typed in.
   */
  evaluateMission() {
    const d = this.dataset;
    const results = { site: d.siteId, t: d.timestamps, sun_lit: d.sunLit, earth_vis: d.earthVis };
    const ev = evaluate(results, { startDate: d.timestamps[0], ...this.mission }, this.requirements);
    d.window = ev.window;
    d.metrics = ev.metrics;
    const f = ev.failure;
    d.failure = f;
    d.firstFailure = f && {
      hourIndex: f.hourIndex,
      durationHours: f.runH ?? 0,
      kind: f.kind,
      message: failureMessage(f, this.siteName(d.siteId)),
      blockingAz: f.kind === 'comm' ? d.earthAz[f.hourIndex] : d.sunAz[f.hourIndex],
    };
    d.okMessage = f ? null : failureMessage(null, this.siteName(d.siteId));
    d.battery = batteryTrace(results, ev.window, this.requirements.battery);
  }

  setDelayDays(days) {
    if (!this.dataset) return;
    this.mission.delayDays = Math.max(0, Math.min(30, Math.round(Number(days) || 0)));
    this.evaluateMission();
    this.setHourIndex(this.dataset.window.startIdx);
  }

  async loadDataset(siteId = 'site04') {
    this.currentSiteId = siteId;

    // Check if real data exists on server
    const realResult = await this.dataLoader.loadSiteData(siteId);

    if (realResult.isReal) {
      this.terrain.loadFromBuffers(
        realResult.heightmap.nearBuffer,
        realResult.heightmap.meta.near,
        realResult.heightmap.farBuffer,
        realResult.heightmap.meta.far
      );
      this.horizon.setFromMaskData(realResult.mask.elev_deg);

      const totalH = realResult.angles.sun_az.length;
      this.dataset = {
        totalHours: totalH,
        siteId,
        timestamps: realResult.angles.t,
        sunAz: new Float32Array(realResult.angles.sun_az),
        sunEl: new Float32Array(realResult.angles.sun_el),
        earthAz: new Float32Array(realResult.angles.earth_az),
        earthEl: new Float32Array(realResult.angles.earth_el),
        sunLit: new Uint8Array(realResult.results.sun_lit),
        earthVis: new Uint8Array(realResult.results.earth_vis),
        isRealData: true,
      };
      // Ray-cast agreement: computed by M2's worker, shown as "computing…" until it answers.
      this.agreement = { sun: null, earth: null };
      if (this.rayWorkers) {
        // A worker resolves relative URLs against its own location, so pass an absolute base.
        const basePath = new URL(this.dataLoader.basePath, document.baseURI).href;
        for (const body of ['sun', 'earth']) {
          const az = realResult.angles[`${body}_az`], el = realResult.angles[`${body}_el`];
          const samples = az.map((a, k) => ({ az: a, el: el[k] }));
          this.rayWorkers[body].postMessage({ basePath, siteId, mast: 2, samples });
        }
      }
    } else {
      // Re-generate distinct topography and dataset for this specific site
      this.terrain.generateProceduralTerrain(siteId);
      this.horizon.generateProceduralMask(this.terrain);
      this.dataset = generateFakeDataset(this.horizon, this.terrain, siteId);
      this.dataset.isRealData = false;
      this.agreement = this.dataset.syntheticAgreement;
    }

    this.evaluateMission();

    if (this.mode === 'overview') {
      if (this.terrain && this.terrain.nearMesh) this.terrain.nearMesh.visible = false;
      if (this.compass) this.compass.setVisible(false);
      if (this.horizon) this.horizon.setVisible(false);
    }

    // Reset lander walking position for the new site
    this.resetLanderPosition();

    this.setHourIndex(this.dataset.window.startIdx);
  }

  sampleGroundHeight(x, z) {
    if (!this.terrain.nearGrid) return 0;
    const grid = this.terrain.nearGrid;

    const gridY = -z;
    const colFloat = (x + grid.sizeM / 2) / grid.cellM;
    const rowFloat = (gridY + grid.sizeM / 2) / grid.cellM;

    const col0 = Math.floor(colFloat);
    const col1 = Math.min(col0 + 1, grid.nx - 1);
    const row0 = Math.floor(rowFloat);
    const row1 = Math.min(row0 + 1, grid.ny - 1);

    if (col0 < 0 || col0 >= grid.nx || row0 < 0 || row0 >= grid.ny) return 0;

    const u = colFloat - col0;
    const v = rowFloat - row0;

    const h00 = grid.data[row0 * grid.nx + col0];
    const h10 = grid.data[row0 * grid.nx + col1];
    const h01 = grid.data[row1 * grid.nx + col0];
    const h11 = grid.data[row1 * grid.nx + col1];

    return (1 - u) * (1 - v) * h00 + u * (1 - v) * h10 + (1 - u) * v * h01 + u * v * h11;
  }

  resetLanderPosition() {
    this.landerX = 0;
    this.landerZ = 0;
    const groundH = this.sampleGroundHeight(0, 0);
    this.camera.position.set(0, groundH + 2.0, 0);
    this.yaw = 0.0;
    this.pitch = 0.04;
    this.trackingTarget = null;
  }

  setHourIndex(index) {
    if (!this.dataset || !this.dataset.window) return;
    const win = this.dataset.window;
    // Replay stays inside the mission window (start date + delay + duration).
    const lo = win.hours ? win.startIdx : 0;
    const hi = win.hours ? win.endIdx - 1 : this.dataset.totalHours - 1;
    this.currentHourIndex = Math.max(lo, Math.min(hi, Math.round(index)));

    const h = this.currentHourIndex;
    const sunAz = this.dataset.sunAz[h];
    const sunEl = this.dataset.sunEl[h];
    const earthAz = this.dataset.earthAz[h];
    const earthEl = this.dataset.earthEl[h];

    this.celestials.updatePositions(sunAz, sunEl, earthAz, earthEl);

    const raySun = testRaycast(sunAz, sunEl, this.terrain);
    const rayEarth = testRaycast(earthAz, earthEl, this.terrain);

    // Battery from missionLogic.batteryTrace (index 0 = landing hour = window start).
    const bt = this.dataset.battery;
    const i = h - win.startIdx;
    const landerState = bt && i >= 0 && i < bt.socWh.length
      ? { socWh: Math.round(bt.socWh[i]),
          socPct: Math.round((100 * bt.socWh[i]) / bt.params.capacityWh),
          commStatus: this.dataset.earthVis[h] === 1 ? 'ONLINE' : 'DISRUPTED',
          params: bt.params }
      : null;

    const ff = this.dataset.firstFailure;

    this.onTelemetryUpdate({
      hourIndex: h,
      siteId: this.currentSiteId,
      siteName: this.siteName(this.currentSiteId),
      window: win,
      totalHours: this.dataset.totalHours,
      delayDays: this.mission.delayDays,
      timestamp: this.dataset.timestamps[h],
      sunAz: sunAz.toFixed(1),
      sunEl: sunEl.toFixed(1),
      earthAz: earthAz.toFixed(1),
      earthEl: earthEl.toFixed(1),
      sunLitEngine: this.dataset.sunLit[h] === 1,
      earthVisEngine: this.dataset.earthVis[h] === 1,
      sunLitRaycast: raySun,
      earthVisRaycast: rayEarth,
      agreement: this.agreement,
      // Once a requirement breaks, the mission has failed: show the banner from that hour on.
      failureEvent: ff && h >= ff.hourIndex ? ff : null,
      firstFailure: ff,
      okMessage: this.dataset.okMessage,
      landerState,
      isRealData: this.dataset.isRealData,
      trackingTarget: this.trackingTarget,
    });
  }

  setViewMode(modeName) {
    this.mode = modeName;

    if (modeName === 'overview') {
      this.orbitControls.enabled = true;
      const currentDist = this.camera.position.distanceTo(this.orbitControls.target) || 4500;
      this.camera.position.set(0, Math.max(2600, currentDist * 0.6), Math.max(3600, currentDist * 0.8));
      this.orbitControls.target.set(0, 0, 0);
      this.orbitControls.update();
      this.celestials.setArrowVisible(true);
      if (this.compass) this.compass.setVisible(false);
      if (this.horizon) this.horizon.setVisible(false);

      // In orbital overview: hide nearMesh so the 60km Moon surface is 100% seamless without square seams!
      if (this.terrain && this.terrain.nearMesh) this.terrain.nearMesh.visible = false;
      if (this.terrain && this.terrain.farMesh) this.terrain.farMesh.visible = true;

      // Fill lighting so orbital craters, terrain topography, and solid block pedestal are clearly visible
      if (this.ambientLight) {
        this.ambientLight.intensity = 1.35;
        this.ambientLight.color.setHex(0x28323e);
      }
      if (this.hemiLight) {
        this.hemiLight.intensity = 0.80;
      }
    } else {
      this.orbitControls.enabled = false;
      const groundH = this.sampleGroundHeight(this.landerX, this.landerZ);
      this.camera.position.set(this.landerX, groundH + 2.0, this.landerZ);
      if (this.compass) this.compass.setVisible(true);
      if (this.horizon) this.horizon.setVisible(true);
      this.celestials.setArrowVisible(false);

      // In lander mast mode: show nearMesh for fine walking resolution
      if (this.terrain && this.terrain.nearMesh) this.terrain.nearMesh.visible = true;
      if (this.terrain && this.terrain.farMesh) this.terrain.farMesh.visible = true;

      // High-contrast lunar mast lighting
      if (this.ambientLight) {
        this.ambientLight.intensity = 0.45;
        this.ambientLight.color.setHex(0x0e141e);
      }
      if (this.hemiLight) {
        this.hemiLight.intensity = 0.30;
      }
    }
  }

  /**
   * Sets continuous camera tracking lock ('sun' | 'earth' | null)
   */
  setTrackingTarget(target) {
    if (this.trackingTarget === target) {
      this.trackingTarget = null; // Toggle off if clicked again
    } else {
      this.trackingTarget = target;
    }

    // Immediate orientation snap/pan toward target
    if (this.trackingTarget === 'sun') {
      this.orientTowardsSun();
    } else if (this.trackingTarget === 'earth') {
      this.orientTowardsEarth();
    }

    this.setHourIndex(this.currentHourIndex); // Refresh telemetry badge
  }

  jumpToFirstFailure() {
    if (!this.dataset || !this.dataset.firstFailure) return;

    const failure = this.dataset.firstFailure;
    this.setHourIndex(failure.hourIndex);

    if (this.mode === 'overview') {
      // Preserve current orbit distance from target
      const currentDist = this.camera.position.distanceTo(this.orbitControls.target) || 4500;
      const dir = bodyDirection(failure.blockingAz, 0);
      this.camera.position.set(-dir.x * currentDist, Math.max(currentDist * 0.35, 1200), -dir.z * currentDist);
      this.orbitControls.target.set(0, 0, 0);
      this.orbitControls.update();
    } else {
      this.targetYaw = (-failure.blockingAz * Math.PI) / 180;
      this.targetPitch = (3.5 * Math.PI) / 180;
    }
  }

  orientTowardsSun() {
    const h = this.currentHourIndex;
    const sAz = this.dataset.sunAz[h];
    const sEl = this.dataset.sunEl[h];

    if (this.mode === 'overview') {
      const currentDist = this.camera.position.distanceTo(this.orbitControls.target) || 4500;
      const sunDir = bodyDirection(sAz, sEl);
      this.camera.position.set(
        -sunDir.x * currentDist,
        Math.max(currentDist * 0.35, -sunDir.y * currentDist + 1200),
        -sunDir.z * currentDist
      );
      this.orbitControls.target.set(0, 0, 0);
      this.orbitControls.update();
    } else {
      this.targetYaw = (-sAz * Math.PI) / 180;
      this.targetPitch = (Math.max(0, sEl) * Math.PI) / 180;
    }
  }

  orientTowardsEarth() {
    const h = this.currentHourIndex;
    const eAz = this.dataset.earthAz[h];
    const eEl = this.dataset.earthEl[h];

    if (this.mode === 'overview') {
      const currentDist = this.camera.position.distanceTo(this.orbitControls.target) || 4500;
      const earthDir = bodyDirection(eAz, eEl);
      this.camera.position.set(
        -earthDir.x * currentDist,
        Math.max(currentDist * 0.35, -earthDir.y * currentDist + 1200),
        -earthDir.z * currentDist
      );
      this.orbitControls.target.set(0, 0, 0);
      this.orbitControls.update();
    } else {
      this.targetYaw = (-eAz * Math.PI) / 180;
      this.targetPitch = (Math.max(0, eEl) * Math.PI) / 180;
    }
  }

  lookNorth() {
    this.trackingTarget = null;
    if (this.mode === 'overview') {
      const currentDist = this.camera.position.distanceTo(this.orbitControls.target) || 3000;
      this.camera.position.set(0, currentDist * 0.5, currentDist * 0.86);
      this.orbitControls.target.set(0, 0, 0);
      this.orbitControls.update();
    } else {
      this.targetYaw = 0.0;
      this.targetPitch = 0.04;
    }
  }

  setPlaying(isPlaying) {
    this.isPlaying = isPlaying;
    this.lastTickTime = performance.now();
  }

  setSpeed(speedMultiplier) {
    this.playbackSpeed = speedMultiplier;
  }

  onResize() {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  animate(now) {
    requestAnimationFrame(this.animate);

    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000.0);
    this.lastFrameTime = now;

    // Playback loop
    if (this.isPlaying && this.dataset) {
      const tickDelta = now - this.lastTickTime;
      const interval = 100 / Math.min(10, this.playbackSpeed);
      if (tickDelta >= interval) {
        this.lastTickTime = now;
        const step = Math.max(1, Math.floor(this.playbackSpeed / 10));
        const win = this.dataset.window;
        let nextHour = this.currentHourIndex + step;
        if (win && win.hours && nextHour >= win.endIdx) nextHour = win.startIdx;
        this.setHourIndex(nextHour);
      }
    }

    // Continuous Tracking Lock Update
    if (this.trackingTarget === 'sun') {
      this.orientTowardsSun();
    } else if (this.trackingTarget === 'earth') {
      this.orientTowardsEarth();
    }

    // Camera Look & Surface Walk in Mode A
    if (this.mode === 'lander') {
      // Smooth look interpolation
      if (this.targetYaw !== null) {
        this.yaw += (this.targetYaw - this.yaw) * 0.1;
        if (Math.abs(this.targetYaw - this.yaw) < 0.001) this.targetYaw = null;
      }
      if (this.targetPitch !== null) {
        this.pitch += (this.targetPitch - this.pitch) * 0.1;
        if (Math.abs(this.targetPitch - this.pitch) < 0.001) this.targetPitch = null;
      }

      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;

      // WASD Surface Traversal
      let moveForward = 0;
      let moveStrafe = 0;
      if (this.keys.KeyW) moveForward += 1;
      if (this.keys.KeyS) moveForward -= 1;
      if (this.keys.KeyD) moveStrafe += 1;
      if (this.keys.KeyA) moveStrafe -= 1;

      if (moveForward !== 0 || moveStrafe !== 0) {
        const speed = (this.keys.ShiftLeft || this.keys.ShiftRight) ? this.moveSpeed * 2.8 : this.moveSpeed;
        const forwardX = -Math.sin(this.yaw);
        const forwardZ = -Math.cos(this.yaw);
        const rightX = Math.cos(this.yaw);
        const rightZ = -Math.sin(this.yaw);

        const dx = (forwardX * moveForward + rightX * moveStrafe) * speed * dt;
        const dz = (forwardZ * moveForward + rightZ * moveStrafe) * speed * dt;

        this.landerX = Math.max(-1900, Math.min(1900, this.landerX + dx));
        this.landerZ = Math.max(-1900, Math.min(1900, this.landerZ + dz));

        const groundH = this.sampleGroundHeight(this.landerX, this.landerZ);
        this.camera.position.set(this.landerX, groundH + 2.0, this.landerZ);
      }
    } else {
      this.orbitControls.update();
    }

    this.renderer.render(this.scene, this.camera);
  }
}
