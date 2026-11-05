/**
 * The realms: Valhalla (the Alliance's hall of stone, gold and aurora) and the Underworld (the Horde's basalt
 * crater with a lava moat). Each is a Blender-built arena GLB plus a lighting, sky and fog preset for the stage,
 * and a couple of animated materials (lava flow, brazier fire).
 */
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { loadModel } from './assets';
import type { AtmospherePreset } from './atmosphere';
import type { FireLights, Grade, Pool, RayColors, SkyExtras, Stage } from './stage';

export type RealmId = 'valhalla' | 'underworld';
export const REALM_NAME: Record<RealmId, string> = { valhalla: 'Valhalla', underworld: 'Underworld' };

interface RealmPreset {
  sky: Parameters<Stage['setSky']>[0];
  aurora: number;
  stars: number;
  key: { color: number; intensity: number; position: [number, number, number] };
  rim: { color: number; intensity: number };
  hemi: { sky: number; ground: number; intensity: number };
  envIntensity: number;
  floor: number;
  /** The polished dais round the board (the mirror on high presets): its radius, or 0 for none. */
  floorRadius: number;
  embers: number;
  /** Volumetric rays from the key light through the shadow map. */
  rays: RayColors;
  /** Light shafts along the key light, the ground mist and the motes. */
  atmosphere: AtmospherePreset;
  /** Moon, clouds and underglow in the sky dome. */
  skyExtras: SkyExtras;
  /** Warm point lights at the fires (Blender coordinates already turned into three's: y up, z = -blender y). */
  fires: FireLights;
  /** The pool of light on the board. */
  pool: Pool;
  grade: Grade;
}

const PRESETS: Record<RealmId, RealmPreset> = {
  valhalla: {
    sky: { top: 0x070b1a, bottom: 0x1a2240, glow: 0x3d5a8a, fog: 0x0a0f1e, fogDensity: 0.02 },
    aurora: 1, stars: 0.9,
    key: { color: 0xfff3e0, intensity: 2.4, position: [6, 12, 5] },
    rim: { color: 0x9fd0ff, intensity: 55 },
    hemi: { sky: 0x4a5a8a, ground: 0x1a1410, intensity: 0.32 },
    envIntensity: 0.45, floor: 0x1a1a22, floorRadius: 9.05, embers: 0xffd27a,
    // moonlight through the open roof: cool, thin, long rays
    rays: { color: 0xa9c6ff, density: 1 / 70, maxDensity: 0.28, distanceAttenuation: 2 },
    atmosphere: {
      shafts: { color: 0x9fc3ff, intensity: 0.55, count: 4 }, mist: { color: 0x8fa6c8, opacity: 0.18 },
      // dust: faint in the hall, silver in the moonbeams
      motes: { color: 0xe6eeff, base: 0.14, rise: 0.04, size: 0.09 },
    },
    // a low moon behind the colonnade, thin cloud lit on its side, the aurora above (setSky)
    skyExtras: { moon: { dir: [-0.5, 0.58, -0.64], color: 0xe4ecff, size: 1 }, clouds: { color: 0x3a4a72, amount: 0.65, speed: 0.006 } },
    pool: { color: 0xdfe8ff, intensity: 70, angle: 0.4 },
    // the four braziers at the board corners: warm pools against the moonlight
    fires: { color: 0xff9a48, intensity: 22, distance: 9, positions: [[-6.6, 2.0, 6.6], [6.6, 2.0, -6.6], [6.6, 2.0, 6.6], [-6.6, 2.0, -6.6]] },
    // cool shadows, warm highlights
    grade: { lift: [0.0, 0.006, 0.022], gamma: [1, 1, 1.02], gain: [1.04, 1.0, 0.95] },
  },
  underworld: {
    sky: { top: 0x050102, bottom: 0x2a0806, glow: 0x7a1a08, fog: 0x120404, fogDensity: 0.024 },
    aurora: 0, stars: 0.25,
    key: { color: 0xffd0b0, intensity: 1.8, position: [-5, 10, -6] },
    rim: { color: 0xff5a2a, intensity: 70 },
    hemi: { sky: 0x4a1a10, ground: 0x200404, intensity: 0.45 },
    envIntensity: 0.5, floor: 0x120606, floorRadius: 0, embers: 0xff6a2a,
    // ember-lit ash: warmer, denser, shorter rays and a heavier haze
    rays: { color: 0xff7a3a, density: 1 / 55, maxDensity: 0.36, distanceAttenuation: 2 },
    atmosphere: {
      shafts: { color: 0xff8a4a, intensity: 0.4, count: 3 }, mist: { color: 0x5a241a, opacity: 0.26 },
      // embers: they glow on their own and rise fast off the lava
      motes: { color: 0xff7a2a, base: 0.5, rise: 0.38, size: 0.05 },
    },
    // churning ash lit red from below, no moon
    skyExtras: { clouds: { color: 0x1a0806, amount: 0.8, speed: 0.012 }, underglow: 1.4 },
    pool: { color: 0xffc89a, intensity: 55, angle: 0.42 },
    // the lava moat glows up onto the board between the bridges
    fires: { color: 0xff4a14, intensity: 26, distance: 10, positions: [[7.7, 0.5, 0], [-7.7, 0.5, 0], [0, 0.5, 7.7], [0, 0.5, -7.7]] },
    // ember-red shadows, hot highlights
    grade: { lift: [0.03, 0.004, 0.0], gamma: [1.02, 1, 0.98], gain: [1.05, 0.96, 0.9] },
  },
};

/** Multipliers on the textured materials: the photo-real stone would otherwise outshine the champions. */
const TINT: Record<string, number> = {
  vh_stone: 0x8e887c, vh_floor: 0x8a8274, vh_blocks: 0x6e675e,
  uw_basalt: 0x3e3236, uw_rock: 0x4e3e3a, uw_ash: 0x5e4e46,
};

export class Realm {
  readonly group = new THREE.Group();
  private animated: THREE.ShaderMaterial[] = [];
  private fires: THREE.MeshStandardMaterial[] = [];
  id: RealmId | null = null;

  constructor(private readonly stage: Stage) {
    stage.scene.add(this.group);
  }

  get preset(): RealmPreset { return PRESETS[this.id ?? 'valhalla']; }

  async load(id: RealmId): Promise<void> {
    if (this.id === id) return;
    this.id = id;
    this.clear();
    const p = PRESETS[id];
    this.stage.setSky(p.sky, p.aurora, p.stars, p.skyExtras);
    this.stage.setFires(p.fires);
    this.stage.setGrade(p.grade);
    this.stage.setPool(p.pool, p.key.position);
    this.stage.keyLight.color.set(p.key.color);
    this.stage.keyLight.intensity = p.key.intensity;
    this.stage.keyLight.position.set(...p.key.position);
    this.stage.rimLight.color.set(p.rim.color);
    this.stage.rimLight.intensity = p.rim.intensity;
    this.stage.hemi.color.set(p.hemi.sky);
    this.stage.hemi.groundColor.set(p.hemi.ground);
    this.stage.hemi.intensity = p.hemi.intensity;
    this.stage.scene.environmentIntensity = p.envIntensity;
    this.stage.setFloorRadius(p.floorRadius);
    this.stage.setRays(p.rays);
    this.stage.atmosphere.apply(p.atmosphere, new THREE.Vector3(...p.key.position));
    const gltf = await loadModel(`${id}.glb`).catch((e) => { console.warn('[chess] realm failed', id, e); return null as GLTF | null; });
    if (!gltf || this.id !== id) return;
    this.dress(gltf.scene, id);
    this.group.add(gltf.scene);
  }

  /** Swap the Blender placeholder materials for the stage's: animated lava, glowing fire, worn stone and metal. */
  private dress(root: THREE.Object3D, id: RealmId): void {
    const cache = new Map<string, THREE.Material>();
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = false;
      o.receiveShadow = true;
      o.frustumCulled = true;
      const src = o.material as THREE.MeshStandardMaterial;
      let m = cache.get(src.name);
      if (!m) { m = this.material(src, id); cache.set(src.name, m); }
      o.material = m;
    });
  }

  private material(src: THREE.MeshStandardMaterial, id: RealmId): THREE.Material {
    const n = src.name;
    if (/lava/.test(n)) return this.lava();
    if (/fire|ember/.test(n)) {
      const m = src.clone();
      m.emissiveIntensity = /fire/.test(n) ? 3.5 : 2.5;
      m.color.set(0x1a0805);
      this.fires.push(m);
      return m;
    }
    if (/rune/.test(n)) { const m = src.clone(); m.emissiveIntensity = 2.2; m.color.set(0x05050a); return m; }
    // Poly Haven stone, ground and rock (scripts/build-arenas.py): keep the maps, darken them to the realm's mood
    if (src.map) {
      const m = src.clone();
      m.color.set(TINT[n] ?? 0x8a8478);
      // matte stone: keep the colour and normal maps for detail, drop the ARM map (read as roughness/metalness it gave
      // glossy patches that the realm's strong rim spot blew out to white, and in the dais mirror too)
      m.metalnessMap = null;
      m.roughnessMap = null;
      m.metalness = 0;
      m.roughness = 0.9;
      m.envMapIntensity = 0.25;
      return m;
    }
    if (/crystal/.test(n)) { const m = src.clone(); m.emissiveIntensity = 2.6; return m; }
    if (/banner/.test(n)) return new THREE.MeshStandardMaterial({ color: 0x14284a, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    if (/gold/.test(n)) return new THREE.MeshStandardMaterial({ color: 0xffbf5e, roughness: 0.3, metalness: 1, envMapIntensity: 1.2 });
    // obsidian: glassy black that catches the lava in its clearcoat, not a grey sheen from the studio environment
    if (/obsidian/.test(n)) return new THREE.MeshPhysicalMaterial({ color: 0x07050a, roughness: 0.22, metalness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.25, envMapIntensity: 0.35 });
    // old bone: aged and dim, so the lava light colours it instead of bleaching it white
    if (/bone/.test(n)) return new THREE.MeshStandardMaterial({ color: 0x6e6252, roughness: 0.85, metalness: 0, envMapIntensity: 0.3 });
    if (/iron/.test(n)) return new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.5, metalness: 0.85, envMapIntensity: 0.6 });
    if (/shield/.test(n)) return new THREE.MeshStandardMaterial({ color: 0x18284a, roughness: 0.55, metalness: 0.35, envMapIntensity: 0.6 });
    if (/basalt/.test(n)) return new THREE.MeshStandardMaterial({ color: 0x15111a, roughness: 0.9, metalness: 0.08 });
    if (/dark/.test(n)) return new THREE.MeshStandardMaterial({ color: 0x1a1613, roughness: 0.7, metalness: 0.15 });
    // worn stone: dark, matte, lit by the braziers and the key; the pieces stay the bright thing on screen
    return new THREE.MeshStandardMaterial({ color: id === 'valhalla' ? 0x4a443c : 0x2a2226, roughness: 0.92, metalness: 0.05, envMapIntensity: 0.35 });
  }

  /** Flowing lava: two layers of scrolling noise, hot cracks over a dark crust, emissive enough to bloom. */
  private lava(): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, hot: { value: new THREE.Color(0xff7a1a) }, crust: { value: new THREE.Color(0x1a0604) }, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0.02 } },
      vertexShader: `varying vec3 vW; varying vec2 vUv; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vUv = w.xz * 0.35; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float time; uniform vec3 hot, crust, fogColor; uniform float fogDensity; varying vec3 vW; varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.1 + 3.7; a *= 0.5; } return v; }
        void main(){
          vec2 uv = vUv + vec2(time * 0.02, time * 0.012);
          float n = fbm(uv * 2.0 + fbm(uv * 1.5 - time * 0.03) * 1.5);
          float cracks = smoothstep(0.42, 0.62, n);
          float glow = pow(cracks, 1.6);
          vec3 c = mix(crust, hot * 3.5, glow) + hot * 0.25 * smoothstep(0.3, 0.45, n);
          float d = length(cameraPosition - vW); float f = 1.0 - exp(-fogDensity * fogDensity * d * d);
          gl_FragColor = vec4(mix(c, fogColor, f), 1.0); }`,
    });
    this.animated.push(m);
    return m;
  }

  update(_dt: number, t: number): void {
    const fog = this.stage.scene.fog as THREE.FogExp2;
    for (const m of this.animated) { m.uniforms.time.value = t; (m.uniforms.fogColor.value as THREE.Color).copy(fog.color); m.uniforms.fogDensity.value = fog.density; }
    for (let i = 0; i < this.fires.length; i++) this.fires[i].emissiveIntensity = 3.0 + 0.8 * Math.sin(t * 7 + i * 1.7) * Math.sin(t * 3.1 + i);
  }

  clear(): void {
    this.group.clear();
    this.animated = [];
    this.fires = [];
  }
}
