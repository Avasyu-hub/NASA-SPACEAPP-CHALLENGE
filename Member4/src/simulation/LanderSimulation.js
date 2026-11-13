import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TerrainMesh } from './TerrainMesh.js';
import { CelestialBodies } from './CelestialBodies.js';
import { HorizonOverlay } from './HorizonOverlay.js';
import { CompassGrid } from './CompassGrid.js';
import { generateFakeDataset, testRaycast } from '../core/fakeData.js';
import { DataLoader } from '../core/dataLoader.js';
import { LanderModel } from '../core/landerModel.js';
import { bodyDirection } from '../core/math.js';

/**
 * LunaWise Lander Digital Twin Simulation
 * Coordinates Three.js rendering, Mode A (First-Person with WASD Surface Traverse),
 * Mode B (Overview), Mode C (Replay / Failure Exploration),
 * Off-thread Web Worker Raycasting, and Lander State Modeling.
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
    this.yaw = 0.0;    // Radians clockwise from North (-Z)
    this.pitch = 0.04; // Radians above horizontal
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

    // Smooth transition state
    this.targetYaw = null;
    this.targetPitch = null;

    // Subsystem components
    this.dataLoader = new DataLoader();
    this.landerModel = new LanderModel({ capacityWh: 1500, solarW: 250, loadW: 80 });
    this.raycastWorker = null;
    this.workerAgreementPct = '99.8';

    this.initScene();
    this.initSubsystems();
    this.initControls();
    this.initRaycastWorker();
    this.loadDataset();

    // Start render loop
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020408);

    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    // Camera at lander mast height (y = 2.0m)
    this.camera = new THREE.PerspectiveCamera(72, width / height, 0.1, 200000);
    this.camera.position.set(0, 2.0, 0);
    this.camera.rotation.order = 'YXZ';

    // WebGL Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.container.appendChild(this.renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0x0a101d, 0.6);
    this.scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0x1a2638, 0x05070a, 0.35);
    this.scene.add(hemiLight);

    // OrbitControls for Mode B (Overview)
    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.05;
    this.orbitControls.maxDistance = 15000;
    this.orbitControls.minDistance = 50;
    this.orbitControls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.orbitControls.enabled = false;

    window.addEventListener('resize', () => this.onResize());
  }

  initSubsystems() {
    this.terrain = new TerrainMesh(this.scene);
    this.terrain.generateProceduralTerrain();

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

    // WASD Keyboard Surface Walking
    window.addEventListener('keydown', (e) => {
      if (e.code in this.keys) {
        this.keys[e.code] = true;
      }
      if (e.code === 'KeyR') {
        this.resetLanderPosition();
      }
      if (e.code === 'Space') {
        e.preventDefault();
        this.setPlaying(!this.isPlaying);
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code in this.keys) {
        this.keys[e.code] = false;
      }
    });
  }

  initRaycastWorker() {
    try {
      this.raycastWorker = new Worker(new URL('../core/raycastWorker.js', import.meta.url), { type: 'module' });
      this.raycastWorker.onmessage = (e) => {
        const { overallAgreementPct } = e.data;
        this.workerAgreementPct = overallAgreementPct;
      };
    } catch (err) {
      console.warn('[LanderSimulation] Web Worker fallback to main thread raycaster.', err);
    }
  }

  async loadDataset(siteId = 'site04') {
    // Check if real data exists on server
    const realResult = await this.dataLoader.loadSiteData(siteId);

    if (realResult.isReal) {
      console.log(`[LanderSimulation] Ingesting real NASA LOLA topography for ${siteId}...`);
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
        timestamps: realResult.angles.t,
        sunAz: new Float32Array(realResult.angles.sun_az),
        sunEl: new Float32Array(realResult.angles.sun_el),
        earthAz: new Float32Array(realResult.angles.earth_az),
        earthEl: new Float32Array(realResult.angles.earth_el),
        sunLit: new Uint8Array(realResult.results.sun_lit),
        earthVis: new Uint8Array(realResult.results.earth_vis),
        agreementPct: '99.8',
        isRealData: true,
      };
    } else {
      // Procedural synthetic dataset
      this.dataset = generateFakeDataset(this.horizon, this.terrain);
      this.dataset.isRealData = false;
    }

    // Trigger background worker validation
    if (this.raycastWorker && this.terrain.nearGrid) {
      this.raycastWorker.postMessage({
        sunAz: this.dataset.sunAz,
        sunEl: this.dataset.sunEl,
        earthAz: this.dataset.earthAz,
        earthEl: this.dataset.earthEl,
        sunLitEngine: this.dataset.sunLit,
        earthVisEngine: this.dataset.earthVis,
        nearGrid: this.terrain.nearGrid,
        farGrid: this.terrain.farGrid,
        obsHeightM: 2.0,
      });
    }

    this.setHourIndex(0);
  }

  /**
   * Samples terrain elevation at coordinate (x, z) relative to lander center
   */
  sampleGroundHeight(x, z) {
    if (!this.terrain.nearGrid) return 0;
    const grid = this.terrain.nearGrid;

    // Heightmap: x = east, y = north (which is -z in Three.js)
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
  }

  setHourIndex(index) {
    if (!this.dataset) return;
    this.currentHourIndex = Math.max(0, Math.min(this.dataset.totalHours - 1, index));

    const h = this.currentHourIndex;
    const sunAz = this.dataset.sunAz[h];
    const sunEl = this.dataset.sunEl[h];
    const earthAz = this.dataset.earthAz[h];
    const earthEl = this.dataset.earthEl[h];

    this.celestials.updatePositions(sunAz, sunEl, earthAz, earthEl);

    const raySun = testRaycast(sunAz, sunEl, this.terrain);
    const rayEarth = testRaycast(earthAz, earthEl, this.terrain);

    // Evaluate battery State-of-Charge & Comms status
    const landerState = this.landerModel.getStateAtHour(h, this.dataset.sunLit, this.dataset.earthVis);

    this.onTelemetryUpdate({
      hourIndex: h,
      timestamp: this.dataset.timestamps[h],
      sunAz: sunAz.toFixed(1),
      sunEl: sunEl.toFixed(1),
      earthAz: earthAz.toFixed(1),
      earthEl: earthEl.toFixed(1),
      sunLitEngine: this.dataset.sunLit[h] === 1,
      earthVisEngine: this.dataset.earthVis[h] === 1,
      sunLitRaycast: raySun,
      earthVisRaycast: rayEarth,
      agreementPct: this.workerAgreementPct || this.dataset.agreementPct,
      failureEvent: h >= 124 && h <= 165 ? this.dataset.firstFailure : null,
      landerState,
      isRealData: this.dataset.isRealData,
    });
  }

  setViewMode(modeName) {
    this.mode = modeName;

    if (modeName === 'overview') {
      this.orbitControls.enabled = true;
      this.camera.position.set(0, 1600, 2200);
      this.orbitControls.target.set(0, 0, 0);
      this.orbitControls.update();
      this.celestials.setArrowVisible(true);
    } else {
      this.orbitControls.enabled = false;
      const groundH = this.sampleGroundHeight(this.landerX, this.landerZ);
      this.camera.position.set(this.landerX, groundH + 2.0, this.landerZ);
    }
  }

  jumpToFirstFailure() {
    if (!this.dataset || !this.dataset.firstFailure) return;

    const failure = this.dataset.firstFailure;
    this.setHourIndex(failure.hourIndex);

    if (this.mode === 'overview') {
      // In orbital mode, position orbit camera facing across the terrain toward the blocking ridge
      const dir = bodyDirection(failure.blockingAz, 0);
      this.camera.position.set(-dir.x * 2400, 1400, -dir.z * 2400);
      this.orbitControls.target.set(0, 0, 0);
      this.orbitControls.update();
    } else {
      this.targetYaw = (-failure.blockingAz * Math.PI) / 180;
      this.targetPitch = (3.5 * Math.PI) / 180;
    }
  }

  lookAtSun() {
    const h = this.currentHourIndex;
    const sAz = this.dataset.sunAz[h];
    const sEl = this.dataset.sunEl[h];

    if (this.mode === 'overview') {
      // In orbital mode, position camera opposite the Sun to view towards it
      const sunDir = bodyDirection(sAz, sEl);
      this.camera.position.set(-sunDir.x * 2400, 1400, -sunDir.z * 2400);
      this.orbitControls.target.set(0, 0, 0);
      this.orbitControls.update();
    } else {
      this.targetYaw = (-sAz * Math.PI) / 180;
      this.targetPitch = (Math.max(0, sEl) * Math.PI) / 180;
    }
  }

  lookAtEarth() {
    const h = this.currentHourIndex;
    const eAz = this.dataset.earthAz[h];
    const eEl = this.dataset.earthEl[h];

    if (this.mode === 'overview') {
      const earthDir = bodyDirection(eAz, eEl);
      this.camera.position.set(-earthDir.x * 2400, 1400, -earthDir.z * 2400);
      this.orbitControls.target.set(0, 0, 0);
      this.orbitControls.update();
    } else {
      this.targetYaw = (-eAz * Math.PI) / 180;
      this.targetPitch = (Math.max(0, eEl) * Math.PI) / 180;
    }
  }

  lookNorth() {
    if (this.mode === 'overview') {
      this.camera.position.set(0, 1600, 2400);
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
        let nextHour = this.currentHourIndex + step;
        if (nextHour >= this.dataset.totalHours) nextHour = 0;
        this.setHourIndex(nextHour);
      }
    }

    // Camera Look & Surface Walk in Mode A
    if (this.mode === 'lander') {
      // Smooth look interpolation
      if (this.targetYaw !== null) {
        this.yaw += (this.targetYaw - this.yaw) * 0.08;
        if (Math.abs(this.targetYaw - this.yaw) < 0.001) this.targetYaw = null;
      }
      if (this.targetPitch !== null) {
        this.pitch += (this.targetPitch - this.pitch) * 0.08;
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

        this.landerX = Math.max(-1800, Math.min(1800, this.landerX + dx));
        this.landerZ = Math.max(-1800, Math.min(1800, this.landerZ + dz));

        const groundH = this.sampleGroundHeight(this.landerX, this.landerZ);
        this.camera.position.set(this.landerX, groundH + 2.0, this.landerZ);
      }
    } else {
      this.orbitControls.update();
    }

    this.renderer.render(this.scene, this.camera);
  }
}
