/**
 * The realms: Valhalla (the Alliance's hall of stone, gold and aurora) and the Underworld (the Horde's basalt
 * crater with a lava moat). Each is a Blender-built arena GLB plus a lighting, sky and fog preset for the stage,
 * and a couple of animated materials (lava flow, brazier fire).
 */
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { loadModel } from './assets';
import type { Stage } from './stage';

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
}

const PRESETS: Record<RealmId, RealmPreset> = {
  valhalla: {
    sky: { top: 0x070b1a, bottom: 0x1a2240, glow: 0x3d5a8a, fog: 0x0a0f1e, fogDensity: 0.02 },
    aurora: 1, stars: 0.9,
    key: { color: 0xfff3e0, intensity: 2.4, position: [6, 12, 5] },
    rim: { color: 0x9fd0ff, intensity: 55 },
    hemi: { sky: 0x4a5a8a, ground: 0x1a1410, intensity: 0.6 },
    envIntensity: 0.6, floor: 0x1a1a22, floorRadius: 9.05, embers: 0xffd27a,
  },
  underworld: {
    sky: { top: 0x050102, bottom: 0x2a0806, glow: 0x7a1a08, fog: 0x120404, fogDensity: 0.024 },
    aurora: 0, stars: 0.25,
    key: { color: 0xffd0b0, intensity: 1.8, position: [-5, 10, -6] },
    rim: { color: 0xff5a2a, intensity: 70 },
    hemi: { sky: 0x4a1a10, ground: 0x200404, intensity: 0.7 },
    envIntensity: 0.5, floor: 0x120606, floorRadius: 0, embers: 0xff6a2a,
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
    this.stage.setSky(p.sky, p.aurora, p.stars);
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
    if (/obsidian/.test(n)) return new THREE.MeshPhysicalMaterial({ color: 0x0a070c, roughness: 0.2, metalness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.25, envMapIntensity: 1.0 });
    if (/bone/.test(n)) return new THREE.MeshStandardMaterial({ color: 0xd8ccb0, roughness: 0.75, metalness: 0 });
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
