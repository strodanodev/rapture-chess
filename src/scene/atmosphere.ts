/**
 * Cheap volumetrics for the arena: shafts of light falling from the key light's direction onto the board
 * (open cones with an additive shader: length and silhouette fade, slow flicker, banding) and two layers of
 * ground mist drifting round the dais (scrolling fbm planes that stay clear of the board and fade before the
 * pillars), and motes: one point cloud of dust (Valhalla) or ash and embers (the Underworld) that drifts through the
 * hall and lights up wherever it crosses a shaft, which is what makes the beams read as volume. Everything is a
 * handful of draw calls with no depth writes; the quality presets only thin it out.
 *
 * The real volumetric scattering, the rays that stream past the champions, is the shadow-aware godrays pass on
 * the stage (three-good-godrays); these are the parts it cannot do cheaply.
 */
import * as THREE from 'three';
import type { Quality } from './stage';

export interface AtmospherePreset {
  shafts: { color: number; intensity: number; count: number };
  mist: { color: number; opacity: number };
  /** Drifting particles: colour, how bright they are outside a shaft (embers glow on their own, dust does not), rise speed. */
  motes: { color: number; base: number; rise: number; size: number };
}

/** Motes per quality preset (one draw call however many). */
const MOTES: Record<Quality, number> = { ultra: 900, high: 650, medium: 350, low: 160, lite: 0 };
const MOTE_MAX = 900;
const MOTE_HEIGHT = 10;

const SHAFT_TARGETS: Array<[number, number]> = [[0.4, -0.6], [-3.4, 2.2], [3.6, 1.4], [-2.2, -3.8], [2.6, -3.2]];
const SHAFT_LENGTH = 19;
const SHAFT_RISE = 15.5;

const SHAFT_VERT = /* glsl */ `
  varying vec2 vUv; varying vec3 vN; varying vec3 vW;
  void main() {
    vUv = uv;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
// CylinderGeometry: uv.y is 1 at the top (the apex, where the light enters) and 0 at the bottom
const SHAFT_FRAG = /* glsl */ `
  uniform vec3 color; uniform float intensity, time, flicker;
  varying vec2 vUv; varying vec3 vN; varying vec3 vW;
  void main() {
    // clamped: interpolation can dip just under 0 where the mirror clips the cone at the floor, and pow() of a
    // negative is NaN, which bloom then spread over the whole picture (a black frame)
    float along = clamp(vUv.y, 0.0, 1.0);
    float lengthFade = smoothstep(0.0, 0.1, along) * pow(along, 2.2);
    vec3 V = normalize(cameraPosition - vW);
    float edge = pow(abs(dot(normalize(vN), V)), 2.4);
    float t = time * 0.6;
    float wobble = sin(t * 2.1) * 0.6 + sin(t * 5.3 + along * 6.0) * 0.4;
    float bands = 0.78 + 0.22 * sin(along * 16.0 + vUv.x * 12.566 + time * 0.4);
    // below the floor the cone is hidden by depth anyway; soften the last metre so the base never reads as a hard disc
    float floorFade = smoothstep(-0.4, 0.9, vW.y);
    vec3 c = color * intensity * lengthFade * edge * bands * (1.0 + wobble * flicker) * floorFade;
    gl_FragColor = vec4(c, 1.0);
  }`;

const MOTE_VERT = /* glsl */ `
  attribute vec4 seed;
  uniform float time, rise, size, height;
  uniform vec3 shaftPos[5]; uniform vec3 shaftDir; uniform int shaftCount;
  varying float vGlow; varying float vFade; varying float vTwinkle;
  void main() {
    vec3 p = position;
    float t = time * (0.35 + seed.w * 0.5);
    p.y = mod(p.y + time * rise * (0.5 + seed.w), height);
    p.x += sin(t + seed.x * 6.2832) * 0.45;
    p.z += cos(t * 0.8 + seed.y * 6.2832) * 0.45;
    // how deep inside a light shaft: the distance to each shaft's axis against the cone's radius there
    float g = 0.0;
    for (int i = 0; i < 5; i++) {
      if (i >= shaftCount) break;
      vec3 d = p - shaftPos[i];
      float along = dot(d, shaftDir);
      float rad = mix(0.22, 1.7, clamp(along / ${SHAFT_LENGTH.toFixed(1)}, 0.0, 1.0));
      g = max(g, 1.0 - smoothstep(rad * 0.35, rad * 1.05, length(d - along * shaftDir)));
    }
    vGlow = g;
    vFade = smoothstep(0.0, 0.8, p.y) * (1.0 - smoothstep(height - 2.0, height, p.y));
    vTwinkle = 0.7 + 0.3 * sin(time * (2.0 + seed.z * 3.0) + seed.x * 40.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = size * (0.55 + seed.z * 0.9) * (1.0 + g * 0.8) * (320.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }`;
const MOTE_FRAG = /* glsl */ `
  uniform vec3 color; uniform float base;
  varying float vGlow; varying float vFade; varying float vTwinkle;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float disc = smoothstep(0.5, 0.0, length(c));
    float light = (base + vGlow * 1.6) * vFade * vTwinkle;
    if (light * disc < 0.004) discard;
    gl_FragColor = vec4(color * light * disc * disc, 1.0);
  }`;

const MIST_VERT = /* glsl */ `
  varying vec3 vW;
  void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const MIST_FRAG = /* glsl */ `
  uniform vec3 color; uniform float opacity, time, clearRadius, fadeRadius, drift;
  varying vec3 vW;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
  float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.3; a *= 0.5; } return v; }
  void main() {
    vec2 p = vW.xz * 0.16;
    float n = fbm(p + vec2(time * 0.022 * drift, -time * 0.013 * drift));
    float m = fbm(p * 1.9 - vec2(time * 0.017 * drift, time * 0.026 * drift));
    float a = smoothstep(0.46, 0.8, n * 0.62 + m * 0.48);
    float r = length(vW.xz);
    a *= smoothstep(clearRadius, clearRadius + 2.6, r);      // the board and the dais stay clear
    a *= 1.0 - smoothstep(fadeRadius, fadeRadius + 4.0, r);  // thins out before the pillars and spires
    a *= smoothstep(1.5, 5.0, length(cameraPosition - vW));  // never a wall in front of the lens
    a *= 1.0 - smoothstep(8.0, 16.0, cameraPosition.y);      // seen from high up it would read as a flat wash
    gl_FragColor = vec4(color, a * opacity);
  }`;

export class Atmosphere {
  readonly group = new THREE.Group();
  private readonly shafts: THREE.Mesh[] = [];
  private readonly shaftMaterial: THREE.ShaderMaterial;
  private readonly mist: THREE.Mesh[] = [];
  private readonly mistMaterials: THREE.ShaderMaterial[] = [];
  private readonly motes: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private shaftCount = SHAFT_TARGETS.length;
  private mistLayers = 2;
  private moteCount = MOTES.high;
  private lightDir = new THREE.Vector3(0.4, 0.8, 0.35).normalize();

  constructor(scene: THREE.Scene) {
    this.group.name = 'Atmosphere';
    scene.add(this.group);

    this.shaftMaterial = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(0x9fc3ff) }, intensity: { value: 0.2 }, time: { value: 0 }, flicker: { value: 0.12 } },
      vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const cone = new THREE.CylinderGeometry(0.22, 1.7, SHAFT_LENGTH, 24, 1, true);
    cone.translate(0, -SHAFT_LENGTH / 2, 0); // apex at the origin, the shaft hangs down local -Y
    for (let i = 0; i < SHAFT_TARGETS.length; i++) {
      const m = new THREE.Mesh(cone, this.shaftMaterial);
      m.frustumCulled = false;
      m.renderOrder = 5;
      m.name = `Shaft_${i}`;
      this.group.add(m);
      this.shafts.push(m);
    }

    const plane = new THREE.PlaneGeometry(44, 44);
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          color: { value: new THREE.Color(0x8fa6c8) }, opacity: { value: 0.22 }, time: { value: i * 37 },
          clearRadius: { value: 5.2 }, fadeRadius: { value: 11.5 }, drift: { value: i ? 0.7 : 1 },
        },
        vertexShader: MIST_VERT, fragmentShader: MIST_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      const m = new THREE.Mesh(plane, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = i ? 0.55 : 0.08;
      m.renderOrder = 4;
      m.name = `Mist_${i}`;
      this.group.add(m);
      this.mist.push(m);
      this.mistMaterials.push(mat);
    }
    this.motes = this.makeMotes();
    this.group.add(this.motes);
    this.aim();
  }

  /** Dust or ash in a 13 m disc over the floor; each mote carries its own phase, size and speed. */
  private makeMotes(): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
    let s = 91;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const pos = new Float32Array(MOTE_MAX * 3), seed = new Float32Array(MOTE_MAX * 4);
    for (let i = 0; i < MOTE_MAX; i++) {
      const a = rnd() * Math.PI * 2, r = 13 * Math.sqrt(rnd());
      pos.set([r * Math.cos(a), rnd() * MOTE_HEIGHT, r * Math.sin(a)], i * 3);
      seed.set([rnd(), rnd(), rnd(), rnd()], i * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, MOTE_HEIGHT / 2, 0), 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(0xffe2b0) }, base: { value: 0.1 }, time: { value: 0 }, rise: { value: 0.05 }, size: { value: 0.06 },
        height: { value: MOTE_HEIGHT }, shaftPos: { value: SHAFT_TARGETS.map(() => new THREE.Vector3()) }, shaftDir: { value: new THREE.Vector3(0, -1, 0) },
        shaftCount: { value: SHAFT_TARGETS.length },
      },
      vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const points = new THREE.Points(geo, mat);
    points.name = 'Motes';
    points.renderOrder = 6;
    return points;
  }

  /** Realm colours, and the key light's position (the shafts fall along that direction). */
  apply(p: AtmospherePreset, keyLightPosition: THREE.Vector3): void {
    (this.shaftMaterial.uniforms.color.value as THREE.Color).set(p.shafts.color);
    this.shaftMaterial.uniforms.intensity.value = p.shafts.intensity;
    this.shaftCount = Math.min(SHAFT_TARGETS.length, p.shafts.count);
    for (const mat of this.mistMaterials) {
      (mat.uniforms.color.value as THREE.Color).set(p.mist.color);
      mat.uniforms.opacity.value = p.mist.opacity;
    }
    const mu = this.motes.material.uniforms;
    (mu.color.value as THREE.Color).set(p.motes.color);
    mu.base.value = p.motes.base;
    mu.rise.value = p.motes.rise;
    mu.size.value = p.motes.size;
    this.lightDir.copy(keyLightPosition).normalize();
    this.aim();
    this.show();
  }

  /** The dais mirror radius: the mist keeps clear of it. */
  setClearRadius(r: number): void {
    for (const mat of this.mistMaterials) mat.uniforms.clearRadius.value = Math.max(4.6, r);
  }

  setQuality(q: Quality): void {
    this.mistLayers = q === 'lite' ? 0 : q === 'low' ? 1 : 2;
    this.moteCount = MOTES[q];
    this.show();
  }

  private show(): void {
    const n = this.shaftCount;
    this.shafts.forEach((m, i) => { m.visible = i < n; });
    this.mist.forEach((m, i) => { m.visible = i < this.mistLayers; });
    this.motes.geometry.setDrawRange(0, this.moteCount);
    this.motes.visible = this.moteCount > 0;
    this.motes.material.uniforms.shaftCount.value = n;
  }

  private static readonly DOWN = new THREE.Vector3(0, -1, 0);
  private aim(): void {
    const toBoard = this.lightDir.clone().negate();
    const q = new THREE.Quaternion().setFromUnitVectors(Atmosphere.DOWN, toBoard);
    this.shafts.forEach((m, i) => {
      const [x, z] = SHAFT_TARGETS[i];
      m.position.set(x, 0, z).addScaledVector(this.lightDir, SHAFT_RISE);
      m.quaternion.copy(q);
      // a little spin round the axis so the banding differs per shaft
      m.rotateY(i * 1.3);
      (this.motes.material.uniforms.shaftPos.value as THREE.Vector3[])[i].copy(m.position);
    });
    (this.motes.material.uniforms.shaftDir.value as THREE.Vector3).copy(toBoard);
  }

  update(_dt: number, t: number): void {
    this.shaftMaterial.uniforms.time.value = t;
    this.motes.material.uniforms.time.value = t;
    for (const mat of this.mistMaterials) mat.uniforms.time.value = t + (mat.uniforms.drift.value as number) * 37;
  }
}
