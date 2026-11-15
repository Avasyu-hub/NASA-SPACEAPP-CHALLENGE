// "Whole Moon" view: the Moon at true scale, lit by the real Sun for the selected hour, with the
// team's LOLA far-field heightmaps (data_out/heightmap/<site>_far.bin, 61 km tiles) draped at the
// south pole, the five candidate sites, and Earth at its true size and distance.
//
// Geometry is exact, not decorative:
//  - site positions come from sites.json lat/lon (MOON_ME frame);
//  - Sun and Earth directions are the site's SPICE azimuth/elevation (data_out/angles) rotated from
//    the local east/north/up frame into MOON_ME;
//  - tile heights are heightmap values + ground height + the curvature (d^2 / 2R) the export removed.
// The global photo map is a low-resolution LRO WAC mosaic (context only, no numbers read from it).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export const R_MOON_M = 1737400;
const R_EARTH_M = 6371000;
const EARTH_DIST_M = 384400000;   // mean distance, for drawing only; direction comes from the data
const D2R = Math.PI / 180;

// MOON_ME (x toward 0° lon, z toward north pole) -> three.js (x, y = north, z = -y_me)
const me = (x, y, z) => new THREE.Vector3(x, z, -y);

/** Local frame at (lat, lon) in three.js coordinates: up, east, north (unit vectors). */
export function siteFrame(latDeg, lonDeg) {
  const p = latDeg * D2R, l = lonDeg * D2R;
  return {
    up: me(Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)),
    east: me(-Math.sin(l), Math.cos(l), 0),
    north: me(-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)),
  };
}

/** Direction (three.js) of a body seen at azimuth az (clockwise from north) and elevation el. */
export function localToWorld(frame, azDeg, elDeg) {
  const a = azDeg * D2R, e = elDeg * D2R;
  return new THREE.Vector3()
    .addScaledVector(frame.east, Math.cos(e) * Math.sin(a))
    .addScaledVector(frame.north, Math.cos(e) * Math.cos(a))
    .addScaledVector(frame.up, Math.sin(e))
    .normalize();
}

const LIT_VERT = /* glsl */`
  varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

// Lambert lighting from the real Sun direction, plus a faint fill so shadowed ground is not pure black.
const SPHERE_FRAG = /* glsl */`
  uniform sampler2D map; uniform vec3 sunDir; uniform float fill;
  varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv;
  void main() {
    // Mosaic is ~0.09 linear on average; scale it to the same exposure as the terrain tiles.
    // Skip the mosaic's dark border columns (3 px left, 6 px right) and its one dark row at the equator.
    vec2 uv = vUv;
    vec2 ts = vec2(textureSize(map, 0));
    uv.x = mix(3.5 / ts.x, 1.0 - 6.5 / ts.x, uv.x);
    float px = 1.0 / ts.y;
    if (abs(uv.y - 0.5) < 0.75 * px) uv.y = 0.5 + 1.25 * px;
    vec3 albedo = texture2D(map, uv).rgb * 6.0;
    // The global mosaic smears toward the pole; fade it to its mean tone there (no invented detail).
    float polar = smoothstep(-0.927, -0.978, normalize(vWorld).y);
    albedo = mix(albedo, vec3(0.54), polar);
    float lam = max(dot(normalize(vNormal), sunDir), 0.0);
    vec3 c = albedo * (pow(lam, 0.85) * 1.45 + fill);
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }`;

// Terrain tiles: each fragment is drawn by the tile of the nearest site that covers it, so the
// overlapping 61 km tiles near the pole meet in clean seams instead of z-fighting.
const TILE_FRAG = /* glsl */`
  #define NS 8
  uniform vec3 sunDir; uniform float fill; uniform int selfIdx; uniform int nSites; uniform float halfSize;
  uniform vec3 siteC[NS]; uniform vec3 siteE[NS]; uniform vec3 siteN[NS];
  varying vec3 vWorld; varying vec3 vNormal;
  void main() {
    vec3 P = normalize(vWorld);
    float dSelf = distance(P, siteC[selfIdx]);
    for (int j = 0; j < NS; j++) {
      if (j >= nSites) break;
      if (j == selfIdx) continue;
      vec3 d = P - siteC[j];
      if (distance(P, siteC[j]) < dSelf && abs(dot(d, siteE[j])) < halfSize && abs(dot(d, siteN[j])) < halfSize) discard;
    }
    float lam = max(dot(normalize(vNormal), sunDir), 0.0);
    vec3 albedo = vec3(0.545, 0.54, 0.53);
    vec3 c = albedo * (pow(lam, 0.85) * 1.45 + fill);
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }`;

const EARTH_FRAG = /* glsl */`
  uniform vec3 sunDir;
  varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv;
  void main() {
    vec3 n = normalize(vNormal);
    float lam = max(dot(n, sunDir), 0.0);
    float band = 0.5 + 0.5 * sin(vUv.y * 18.0 + sin(vUv.x * 9.0) * 1.3);
    vec3 ocean = vec3(0.10, 0.28, 0.62), cloud = vec3(0.86, 0.9, 0.96);
    vec3 albedo = mix(ocean, cloud, smoothstep(0.72, 0.95, band) * 0.6);
    gl_FragColor = vec4(albedo * (lam * 1.4 + 0.02), 1.0);
    #include <colorspace_fragment>
  }`;

function glowTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner); grad.addColorStop(0.18, inner); grad.addColorStop(1, outer);
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class MoonGlobe {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect || (() => {});
    this.sites = [];
    this.tiles = new Map();
    this.labels = new Map();
    this.status = {};
    this.selectedId = null;
    this.visible = true;
    this.fly = null;

    const w = container.clientWidth || window.innerWidth, h = container.clientHeight || window.innerHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030407);
    this.camera = new THREE.PerspectiveCamera(38, w / h, 1e-5, 4000);
    this.camera.up.set(0, -1, 0);            // south pole "up": the polar sites read naturally
    this.camera.position.set(0.0, -2.35, 1.75);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.rotateSpeed = 0.55;
    this.controls.minDistance = 0.006;
    this.controls.maxDistance = 14;
    this.controls.target.set(0, -0.55, 0);
    this.controls.addEventListener('start', () => { this.fly = null; });

    this.sunDir = new THREE.Vector3(1, 0, 0);
    this.initStars();
    this.initMoon();
    this.initSunEarth();

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'globe-labels';
    container.appendChild(this.labelLayer);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.loop = this.loop.bind(this);
    this.last = performance.now();
    requestAnimationFrame(this.loop);
  }

  initStars() {
    // Decorative background only (not a star catalogue).
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const n = 2600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      pos.set([s * Math.cos(t) * 3000, u * 3000, s * Math.sin(t) * 3000], i * 3);
      const b = 0.25 + Math.pow(rnd(), 3) * 0.75;
      col.set([b * 0.9, b * 0.93, b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      size: 1.3, sizeAttenuation: false, vertexColors: true, depthWrite: false })));
  }

  initMoon() {
    const tex = new THREE.TextureLoader().load('./textures/moon_map.jpg');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.sphereMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, sunDir: { value: this.sunDir }, fill: { value: 0.035 } },
      vertexShader: LIT_VERT, fragmentShader: SPHERE_FRAG,
    });
    // Drawn 8 km below the reference radius so the real terrain (incl. Shackleton's floor) sits on top.
    const r = (R_MOON_M - 8000) / R_MOON_M;
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(r, 192, 128), this.sphereMat);
    this.scene.add(this.moon);

    // Graticule: 80°, 85° S rings and the 0° / 90° / 180° / 270° meridians near the pole.
    const lineMat = new THREE.LineBasicMaterial({ color: 0x5b8ef0, transparent: true, opacity: 0.22 });
    const ring = (lat) => {
      const pts = [];
      for (let k = 0; k <= 180; k++) pts.push(siteFrame(lat, k * 2).up.multiplyScalar(1.0006));
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
    };
    [-80, -85, -88].forEach((lat) => this.scene.add(ring(lat)));
    for (let lon = 0; lon < 360; lon += 30) {
      const pts = [];
      for (let lat = -89.9; lat <= -75; lat += 0.5) pts.push(siteFrame(lat, lon).up.multiplyScalar(1.0006));
      this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }

    this.tileUniforms = {
      sunDir: { value: this.sunDir }, fill: { value: 0.035 }, nSites: { value: 0 },
      halfSize: { value: 0 },
      siteC: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
      siteE: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
      siteN: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
    };
  }

  initSunEarth() {
    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture('rgba(255,246,220,1)', 'rgba(255,200,120,0)'), depthWrite: false,
      transparent: true, sizeAttenuation: false }));
    this.sunSprite.scale.set(0.09, 0.09, 1);
    this.scene.add(this.sunSprite);

    this.earthMat = new THREE.ShaderMaterial({
      uniforms: { sunDir: { value: this.sunDir } }, vertexShader: LIT_VERT, fragmentShader: EARTH_FRAG });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH_M / R_MOON_M, 64, 48), this.earthMat);
    this.scene.add(this.earth);

    // Direction rays from the selected site toward the Sun and Earth (length 0.12 R ≈ 210 km).
    const ray = (color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
      const l = new THREE.Line(g, new THREE.LineDashedMaterial({
        color, dashSize: 0.004, gapSize: 0.003, transparent: true, opacity: 0.95, depthTest: false }));
      l.renderOrder = 5;
      l.visible = false;
      this.scene.add(l);
      return l;
    };
    this.sunRay = ray(0xffd58a);
    this.earthRay = ray(0x5b8ef0);
  }

  /** sites: entries of sites.json. Positions are exact; markers float 2 km above the ground. */
  setSites(sites) {
    this.sites = sites;
    this.frames = new Map(sites.map((s) => [s.id, siteFrame(s.lat, s.lon)]));
    const u = this.tileUniforms;
    u.nSites.value = Math.min(8, sites.length);
    sites.slice(0, 8).forEach((s, i) => {
      const f = this.frames.get(s.id);
      u.siteC.value[i].copy(f.up); u.siteE.value[i].copy(f.east); u.siteN.value[i].copy(f.north);
    });
    this.labelLayer.innerHTML = '';
    this.labels.clear();
    for (const s of sites) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'globe-label';
      el.innerHTML = `<i></i><span class="gl-id">${s.id.toUpperCase()}</span><span class="gl-name">${s.name.replace(/\s*\(PGDA Site\d+\)/, '')}</span>`;
      el.addEventListener('click', (e) => { e.stopPropagation(); this.onSelect(s.id); });
      this.labelLayer.appendChild(el);
      this.labels.set(s.id, el);
    }
  }

  sitePoint(id, extraM = 0) {
    const s = this.sites.find((x) => x.id === id);
    if (!s) return null;
    return this.frames.get(id).up.clone().multiplyScalar((R_MOON_M + s.ground_height_m + extraM) / R_MOON_M);
  }

  /** Drape one site's far-field heightmap (512×512 at 120 m) as a lit tile, decimated ×2. */
  addTerrainTile(siteId, meta, far, stride = 2) {
    const idx = this.sites.findIndex((s) => s.id === siteId);
    if (idx < 0 || this.tiles.has(siteId)) return;
    const s = this.sites[idx], f = this.frames.get(siteId), m = meta.far;
    const nx = Math.floor(m.nx / stride), ny = Math.floor(m.ny / stride);
    const center = f.up.clone().multiplyScalar((R_MOON_M + s.ground_height_m) / R_MOON_M);
    const pos = new Float32Array(nx * ny * 3);
    const v = new THREE.Vector3();
    for (let r = 0; r < ny; r++) {
      for (let c = 0; c < nx; c++) {
        const rr = r * stride, cc = c * stride;
        const x = (cc + 0.5) * m.cell_m - m.size_m / 2;    // east, m
        const y = (rr + 0.5) * m.cell_m - m.size_m / 2;    // north, m
        let hgt = far[rr * m.nx + cc];
        if (!Number.isFinite(hgt)) hgt = 0;
        const trueH = hgt + s.ground_height_m + (x * x + y * y) / (2 * R_MOON_M);
        v.copy(f.up).multiplyScalar(R_MOON_M).addScaledVector(f.east, x).addScaledVector(f.north, y)
          .normalize().multiplyScalar((R_MOON_M + trueH) / R_MOON_M).sub(center);
        pos.set([v.x, v.y, v.z], (r * nx + c) * 3);
      }
    }
    const index = [];
    for (let r = 0; r < ny - 1; r++) {
      for (let c = 0; c < nx - 1; c++) {
        const a = r * nx + c, b = a + 1, d = a + nx, e = d + 1;
        index.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    // Index winding: make normals point away from the Moon's centre.
    const n0 = new THREE.Vector3().fromBufferAttribute(g.getAttribute('normal'), Math.floor((nx * ny) / 2));
    if (n0.dot(f.up) < 0) {
      for (let k = 0; k < index.length; k += 3) { const t = index[k + 1]; index[k + 1] = index[k + 2]; index[k + 2] = t; }
      g.setIndex(index);
      g.computeVertexNormals();
    }
    this.tileUniforms.halfSize.value = (0.5 * m.size_m) / R_MOON_M;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.tileUniforms, selfIdx: { value: idx } },
      vertexShader: LIT_VERT, fragmentShader: TILE_FRAG,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.copy(center);
    this.scene.add(mesh);
    this.tiles.set(siteId, mesh);
  }

  /**
   * Time step: Sun/Earth az/el at the selected site for the current hour (data_out/angles) and the
   * engine flags (data_out/results) for that hour.
   */
  setSky(siteId, { sunAz, sunEl, earthAz, earthEl, sunLit, earthVis }) {
    const f = this.frames?.get(siteId);
    if (!f || !Number.isFinite(sunAz)) return;
    this.sunDir.copy(localToWorld(f, sunAz, sunEl));
    const eDir = localToWorld(f, earthAz, earthEl);
    const p = this.sitePoint(siteId, 0);
    this.earth.position.copy(p).addScaledVector(eDir, EARTH_DIST_M / R_MOON_M);
    this.sunSprite.position.copy(this.sunDir).multiplyScalar(2500);
    const len = 0.12;
    const set = (line, dir, color) => {
      const a = this.sitePoint(siteId, 300);
      line.geometry.setFromPoints([a, a.clone().addScaledVector(dir, len)]);
      line.computeLineDistances();
      line.material.color.set(color);
      line.visible = true;
    };
    set(this.sunRay, this.sunDir, sunLit ? 0xffd58a : 0xff5a4f);
    set(this.earthRay, eDir, earthVis ? 0x5b8ef0 : 0xff5a4f);
    this.sky = { sunLit, earthVis };
  }

  /** status: { [siteId]: 'pass' | 'fail' | 'na' } for the marker colours. */
  setStatus(status) {
    this.status = status;
    for (const [id, el] of this.labels) el.dataset.status = status[id] || 'na';
  }

  select(id, { fly = true } = {}) {
    this.selectedId = id;
    for (const [sid, el] of this.labels) el.classList.toggle('is-selected', sid === id);
    if (fly) this.flyToSite(id);
  }

  flyToSite(id, dist = 0.075) {
    const f = this.frames?.get(id);
    if (!f) return;
    const target = this.sitePoint(id);
    const off = f.up.clone().multiplyScalar(0.62).addScaledVector(f.north, 0.78).normalize().multiplyScalar(dist);
    this.flyTo(target, target.clone().add(off));
  }

  flyHome() {
    this.flyTo(new THREE.Vector3(0, -0.55, 0), new THREE.Vector3(0.0, -2.35, 1.75));
  }

  flyTo(target, camPos, ms = 1600) {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.fly = { t0: performance.now(), ms: reduce ? 1 : ms,
      fromT: this.controls.target.clone(), toT: target, fromC: this.camera.position.clone(), toC: camPos };
  }

  setVisible(v) {
    this.visible = v;
    this.container.style.visibility = v ? 'visible' : 'hidden';
    if (v) this.resize();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  updateLabels() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const cam = this.camera.position;
    const placed = [];
    for (const s of this.sites) {
      const el = this.labels.get(s.id);
      const p = this.sitePoint(s.id, 1500);
      const facing = p.clone().normalize().dot(cam.clone().sub(p).normalize()) > -0.02;
      const q = p.clone().project(this.camera);
      if (!facing || q.z > 1 || Math.abs(q.x) > 1.2 || Math.abs(q.y) > 1.2) { el.style.display = 'none'; continue; }
      el.style.display = '';
      let x = (q.x * 0.5 + 0.5) * w, y = (-q.y * 0.5 + 0.5) * h;
      placed.push({ el, x, y, dotX: x, dotY: y });
    }
    // Keep labels from overlapping: stack them vertically, leader dot stays on the true position.
    placed.sort((a, b) => a.y - b.y);
    for (let i = 1; i < placed.length; i++) {
      for (let j = 0; j < i; j++) {
        if (Math.abs(placed[i].x - placed[j].x) < 190 && placed[i].y - placed[j].y < 26) placed[i].y = placed[j].y + 26;
      }
    }
    for (const p of placed) {
      p.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      p.el.style.setProperty('--lead', `${(p.dotY - p.y).toFixed(1)}px`);
    }
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    if (!this.visible) return;
    if (this.fly) {
      const k = Math.min(1, (now - this.fly.t0) / this.fly.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.controls.target.lerpVectors(this.fly.fromT, this.fly.toT, e);
      this.camera.position.lerpVectors(this.fly.fromC, this.fly.toC, e);
      if (k >= 1) this.fly = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
  }
}
