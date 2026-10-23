/** Loaders for the Blender-built set (Draco) and the Rapture champion avatars, with a per-slug cache. */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);

const avatars = new Map<string, Promise<GLTF>>();

export const loadSet = (): Promise<GLTF> => loader.loadAsync(`${import.meta.env.BASE_URL}models/set.glb`);
export const loadModel = (file: string): Promise<GLTF> => loader.loadAsync(`${import.meta.env.BASE_URL}models/${file}`);

export function loadAvatar(slug: string): Promise<GLTF> {
  let p = avatars.get(slug);
  if (!p) {
    p = loader.loadAsync(`${import.meta.env.BASE_URL}models/avatars/${slug}.glb`);
    avatars.set(slug, p);
    p.catch(() => avatars.delete(slug));
  }
  return p;
}

/** Load a list of avatars with a progress callback (0..1). */
export async function preloadAvatars(slugs: string[], onProgress: (done: number, total: number) => void): Promise<void> {
  const unique = [...new Set(slugs)];
  let done = 0;
  onProgress(0, unique.length);
  await Promise.all(unique.map((s) => loadAvatar(s).catch((e) => console.warn('[chess] avatar failed', s, e)).then(() => onProgress(++done, unique.length))));
}

let soft: THREE.Texture | null = null;
/** A soft radial sprite for particles and glow pools. */
export function softParticleTexture(): THREE.Texture {
  if (soft) return soft;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  soft = new THREE.CanvasTexture(c);
  soft.colorSpace = THREE.SRGBColorSpace;
  return soft;
}

/** Procedural marble (fbm veins) for the light squares: no texture download, and it tiles. */
export function marbleTexture(size = 512, veinColor = '#9c8f7c', base = '#efe8da'): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  const vein = new THREE.Color(veinColor), bg = new THREE.Color(base);
  const perm = new Uint8Array(512);
  let s = 1337;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const p = Array.from({ length: 256 }, (_, i) => i).sort(() => rnd() - 0.5);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, x: number, y: number) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
  const noise = (x: number, y: number) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255; x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const a = perm[X] + Y, b = perm[X + 1] + Y;
    const l = (t: number, p0: number, p1: number) => p0 + t * (p1 - p0);
    return l(v, l(u, grad(perm[a], x, y), grad(perm[b], x - 1, y)), l(u, grad(perm[a + 1], x, y - 1), grad(perm[b + 1], x - 1, y - 1)));
  };
  const fbm = (x: number, y: number) => { let f = 0, a = 0.5, fr = 1; for (let i = 0; i < 5; i++) { f += a * noise(x * fr, y * fr); a *= 0.5; fr *= 2; } return f; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = x / size * 4, ny = y / size * 4;
    const v = Math.abs(Math.sin((nx + fbm(nx, ny) * 2.2) * 3.0));
    const k = Math.pow(1 - v, 6) * 0.9 + fbm(nx * 3, ny * 3) * 0.08;
    const i = (y * size + x) * 4;
    d[i] = (bg.r + (vein.r - bg.r) * k) * 255; d[i + 1] = (bg.g + (vein.g - bg.g) * k) * 255; d[i + 2] = (bg.b + (vein.b - bg.b) * k) * 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
