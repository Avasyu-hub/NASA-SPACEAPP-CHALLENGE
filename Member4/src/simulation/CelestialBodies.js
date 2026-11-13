import * as THREE from 'three';
import { bodyDirection } from '../core/math.js';

/**
 * Manages the Sun, Earth, deep space starfield, directional illumination, and dynamic shadows.
 * Features:
 * - Deep space starfield (3,000+ stars with realistic stellar temperatures and magnitudes)
 * - White-hot solar disk with luminous corona halo
 * - Detailed Earth (continents, blue oceans, clouds) + atmospheric limb Fresnel glow
 * - Directional light calibrated for grazing lunar shadow casting
 */
export class CelestialBodies {
  constructor(scene) {
    this.scene = scene;
    this.skyRadius = 70000.0; // Distance on sky sphere (meters)
    this.exaggeration = 1.0;

    this.sunAz = 0.0;
    this.sunEl = 1.5;
    this.earthAz = 15.0;
    this.earthEl = 2.0;

    this.initStarfield();
    this.initSun();
    this.initEarth();
    this.initEarthArrow();

    this.updatePositions(this.sunAz, this.sunEl, this.earthAz, this.earthEl);
  }

  /**
   * 1. Deep Space Starfield
   * Generates 3,000+ stars across the celestial sphere with realistic stellar spectral colors.
   */
  initStarfield() {
    const starCount = 3200;
    const starGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);

    const starRadius = 140000.0; // Outside celestial bodies

    // Stellar spectral color palette (O/B blue-white, A white, G solar yellow, K/M orange-red)
    const spectralColors = [
      new THREE.Color(0xdce6ff), // B-type blue-white
      new THREE.Color(0xf8f9fa), // A-type crisp white
      new THREE.Color(0xfff4e6), // F-type pale yellow-white
      new THREE.Color(0xffe4b5), // G-type warm yellow (Sun-like)
      new THREE.Color(0xffd1a4), // K-type orange
    ];

    for (let i = 0; i < starCount; i++) {
      // Uniform point on sphere
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);

      const x = starRadius * Math.sin(phi) * Math.cos(theta);
      const y = starRadius * Math.cos(phi);
      const z = starRadius * Math.sin(phi) * Math.sin(theta);

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      // Pick spectral color
      const col = spectralColors[Math.floor(Math.random() * spectralColors.length)];
      // Brightness variation
      const brightness = Math.pow(Math.random(), 2.8) * 0.8 + 0.2;
      colors[i * 3] = col.r * brightness;
      colors[i * 3 + 1] = col.g * brightness;
      colors[i * 3 + 2] = col.b * brightness;
    }

    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const starMat = new THREE.PointsMaterial({
      size: 2.0,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      sizeAttenuation: false,
    });

    this.starPoints = new THREE.Points(starGeo, starMat);
    this.scene.add(this.starPoints);
  }

  /**
   * 2. The Sun
   * Airless lunar view: blinding pure white solar disk with radiant corona halo.
   */
  initSun() {
    this.sunGroup = new THREE.Group();
    this.scene.add(this.sunGroup);

    // Base physical radius at 70,000m: 70000 * tan(0.53° / 2) ~ 324m
    this.sunBaseRadius = 324.0;

    // Blinding white core disk
    this.sunGeo = new THREE.SphereGeometry(this.sunBaseRadius, 32, 32);
    this.sunMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, // Pure white in airless space
    });
    this.sunMesh = new THREE.Mesh(this.sunGeo, this.sunMat);
    this.sunGroup.add(this.sunMesh);

    // Luminous Corona Glow (Additive Billboard Sprite)
    const coronaTexture = this.generateCoronaTexture();
    const coronaMat = new THREE.SpriteMaterial({
      map: coronaTexture,
      color: 0xfff2d4,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.coronaSprite = new THREE.Sprite(coronaMat);
    this.coronaBaseScale = this.sunBaseRadius * 7.5;
    this.coronaSprite.scale.set(this.coronaBaseScale, this.coronaBaseScale, 1);
    this.sunGroup.add(this.coronaSprite);

    // Directional Sunlight (Casting real-time grazing shadows across terrain)
    this.sunLight = new THREE.DirectionalLight(0xfffcf0, 2.4);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 100;
    this.sunLight.shadow.camera.far = 150000;

    const d = 3600;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;

    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.05;

    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
  }

  generateCoronaTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    const grad = ctx.createRadialGradient(128, 128, 6, 128, 128, 128);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.12, 'rgba(255, 250, 230, 0.85)');
    grad.addColorStop(0.32, 'rgba(255, 215, 130, 0.35)');
    grad.addColorStop(0.65, 'rgba(255, 180, 70, 0.1)');
    grad.addColorStop(1.0, 'rgba(255, 140, 20, 0.0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);

    return new THREE.CanvasTexture(canvas);
  }

  /**
   * 3. The Earth ("Blue Marble" with Atmosphere Limb)
   */
  initEarth() {
    this.earthGroup = new THREE.Group();
    this.scene.add(this.earthGroup);

    // Base physical radius: 70000 * tan(1.90° / 2) ~ 1160m
    this.earthBaseRadius = 1160.0;

    // Detailed procedural Earth Surface texture
    const earthTexture = this.generateEarthTexture();

    this.earthGeo = new THREE.SphereGeometry(this.earthBaseRadius, 48, 48);
    this.earthMat = new THREE.MeshStandardMaterial({
      map: earthTexture,
      roughness: 0.65,
      metalness: 0.1,
    });
    this.earthMesh = new THREE.Mesh(this.earthGeo, this.earthMat);
    this.earthMesh.rotation.z = (23.44 * Math.PI) / 180;
    this.earthGroup.add(this.earthMesh);

    // Atmospheric Limb Glow (Outer thin blue shell with Fresnel falloff)
    const atmosphereGeo = new THREE.SphereGeometry(this.earthBaseRadius * 1.035, 48, 48);
    const atmosphereMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
          vec3 viewDir = normalize(-vPosition);
          float edge = 1.0 - max(0.0, dot(vNormal, viewDir));
          float intensity = pow(edge, 3.2) * 1.35;
          gl_FragColor = vec4(0.28, 0.72, 1.0, intensity);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });

    this.earthAtmosphere = new THREE.Mesh(atmosphereGeo, atmosphereMat);
    this.earthGroup.add(this.earthAtmosphere);
  }

  generateEarthTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');

    // 1. Deep Ocean
    const oceanGrad = ctx.createLinearGradient(0, 0, 0, 512);
    oceanGrad.addColorStop(0, '#0a224a');
    oceanGrad.addColorStop(0.5, '#071836');
    oceanGrad.addColorStop(1, '#0a224a');
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(0, 0, 1024, 512);

    // 2. Continents
    const drawLand = (cx, cy, rx, ry, col = '#385e38') => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0.1, 0, Math.PI * 2);
      ctx.fill();
    };

    drawLand(260, 170, 70, 100, '#3a5832'); // N. America
    drawLand(320, 340, 50, 90, '#2e4d28');  // S. America
    drawLand(580, 160, 130, 80, '#425b30'); // Eurasia
    drawLand(540, 290, 70, 90, '#535b2e');  // Africa & Sahara
    drawLand(800, 360, 45, 35, '#6a5a3a');  // Australia

    // Polar Ice
    ctx.fillStyle = '#e8f0fe';
    ctx.fillRect(0, 470, 1024, 42);
    ctx.fillRect(0, 0, 1024, 30);

    // 3. Swirling cloud patterns
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    for (let i = 0; i < 30; i++) {
      const cx = (i * 36) % 1024;
      const cy = 120 + Math.sin(i * 0.7) * 160;
      const w = 90 + (i % 5) * 20;
      const h = 20 + (i % 3) * 8;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w, h, 0.25 * Math.sin(i), 0, Math.PI * 2);
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    return texture;
  }

  initEarthArrow() {
    this.earthArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0, 2.0, 0),
      400.0,
      0x00d4ff,
      40.0,
      18.0
    );
    this.scene.add(this.earthArrow);
  }

  updatePositions(sunAz, sunEl, earthAz, earthEl) {
    this.sunAz = sunAz;
    this.sunEl = sunEl;
    this.earthAz = earthAz;
    this.earthEl = earthEl;

    // 1. Sun
    const sunDir = bodyDirection(sunAz, sunEl);
    this.sunGroup.position.copy(sunDir.clone().multiplyScalar(this.skyRadius));

    this.sunLight.position.copy(sunDir.clone().multiplyScalar(10000.0));
    this.sunLight.target.position.set(0, 0, 0);

    if (sunEl < 0) {
      this.sunLight.intensity = Math.max(0, 2.4 * (1.0 + sunEl * 0.5));
      this.coronaSprite.material.opacity = Math.max(0, 1.0 + sunEl * 0.4);
    } else {
      this.sunLight.intensity = 2.4;
      this.coronaSprite.material.opacity = 1.0;
    }

    // 2. Earth
    const earthDir = bodyDirection(earthAz, earthEl);
    this.earthGroup.position.copy(earthDir.clone().multiplyScalar(this.skyRadius));
    this.earthMesh.rotation.y += 0.002;

    this.earthArrow.setDirection(earthDir);
  }

  setExaggeration(mult) {
    this.exaggeration = mult;
    this.sunMesh.scale.setScalar(mult);
    this.coronaSprite.scale.set(this.coronaBaseScale * mult, this.coronaBaseScale * mult, 1);
    this.earthGroup.scale.setScalar(mult);
  }

  setArrowVisible(visible) {
    this.earthArrow.visible = visible;
  }
}
