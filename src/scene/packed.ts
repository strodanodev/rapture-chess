/**
 * Packed surfaces: several colour-only materials folded into one, the surface carried per vertex instead: base colour
 * (`color`), emitted light (`aEmissive`), roughness / metalness / environment strength (`aPbr`), and a rune mask
 * (`aRune`) lit by the material's own `rune` colour. A champion (five skinned meshes over one skeleton, four or five
 * materials) and a plinth (stone, gold cap, rune) each become one mesh: one draw call per pass instead of three to
 * seven, and the scene is drawn up to three times a frame (main, shadow map, mirror floor).
 *
 * Every packed material compiles to the same program; a piece clones its own (for its rune colour and its fade).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** One part's surface, as the shader reads it per vertex. `emissive` is already scaled by its intensity. */
export interface Surface { color: THREE.Color; emissive: THREE.Color; roughness: number; metalness: number; env: number; rune: number }

/** A material's surface; a rune part (`rune` 1) emits only the piece's colour, never the material's own glow. */
export function surfaceOf(m: THREE.MeshStandardMaterial, rune = 0): Surface {
  return {
    color: m.color.clone(), emissive: rune ? new THREE.Color(0, 0, 0) : m.emissive.clone().multiplyScalar(m.emissiveIntensity),
    roughness: m.roughness, metalness: m.metalness, env: m.envMapIntensity, rune,
  };
}

const KEEP: Record<string, typeof Float32Array | typeof Uint16Array> = { position: Float32Array, normal: Float32Array, skinIndex: Uint16Array, skinWeight: Float32Array };

/** Plain, non-interleaved, non-normalized copies of the attributes every part shares, so parts from different exports always merge. */
function plain(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, Ctor] of Object.entries(KEEP)) {
    const a = src.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!a) continue;
    const n = a.itemSize, out = new Ctor(a.count * n);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = a.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(out, n));
  }
  if (src.index) g.setIndex(Array.from(src.index.array));
  return g;
}

function paint(g: THREE.BufferGeometry, s: Surface): void {
  const n = g.getAttribute('position').count;
  const color = new Float32Array(n * 3), emissive = new Float32Array(n * 3), pbr = new Float32Array(n * 3), rune = new Float32Array(n).fill(s.rune);
  for (let i = 0; i < n; i++) {
    color.set([s.color.r, s.color.g, s.color.b], i * 3);
    emissive.set([s.emissive.r, s.emissive.g, s.emissive.b], i * 3);
    pbr.set([s.roughness, s.metalness, s.env], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setAttribute('aEmissive', new THREE.BufferAttribute(emissive, 3));
  g.setAttribute('aPbr', new THREE.BufferAttribute(pbr, 3));
  g.setAttribute('aRune', new THREE.BufferAttribute(rune, 1));
}

/** Merge parts into one geometry: each part's vertices moved by `matrix` and painted with its surface. */
export function packGeometry(parts: Array<{ geometry: THREE.BufferGeometry; matrix: THREE.Matrix4; surface: Surface }>): THREE.BufferGeometry | null {
  let gs = parts.map((p) => { const g = plain(p.geometry); g.applyMatrix4(p.matrix); paint(g, p.surface); return g; });
  if (gs.some((g) => !g.index) && gs.some((g) => g.index)) gs = gs.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(gs, false);
  for (const g of gs) g.dispose();
  return merged;
}

/** The shader patch, one function for every packed material (so they all share a program). */
function patch(this: PackedMaterial, shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.runeEmissive = this.rune;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aEmissive;\nattribute vec3 aPbr;\nattribute float aRune;\nvarying vec3 vEmissive;\nvarying vec3 vPbr;\nvarying float vRune;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmissive = aEmissive; vPbr = aPbr; vRune = aRune;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 runeEmissive;\nvarying vec3 vEmissive;\nvarying vec3 vPbr;\nvarying float vRune;')
    // the environment strength is per vertex too: the IBL functions read the name, so point it at the varying
    .replace('#include <envmap_common_pars_fragment>', '#include <envmap_common_pars_fragment>\n#define envMapIntensity vPbr.z')
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;')
    .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = vEmissive + vRune * runeEmissive;');
}

export class PackedMaterial extends THREE.MeshStandardMaterial {
  readonly isPackedMaterial = true;
  /** The rune's emitted light (colour times intensity), added where `aRune` is 1. */
  readonly rune = { value: new THREE.Color(0, 0, 0) };

  constructor(params: THREE.MeshStandardMaterialParameters = {}) {
    super({ ...params, vertexColors: true, color: 0xffffff });
    this.onBeforeCompile = patch;
  }

  override customProgramCacheKey(): string { return 'packed-surface-1'; }

  override copy(source: PackedMaterial): this {
    super.copy(source);
    this.onBeforeCompile = patch;
    if (source.rune) this.rune.value.copy(source.rune.value);
    return this;
  }
}

export const isPacked = (m: THREE.Material): m is PackedMaterial => (m as PackedMaterial).isPackedMaterial === true;

/**
 * Fold a model's skinned meshes into one packed skinned mesh per skeleton and face side, in place. `surface` gives a
 * material's surface, or null to leave that mesh as it is (glass: it sorts and blends on its own).
 *
 * Each part's vertices are moved by its own bind matrix and the packed mesh binds with the identity: an attached
 * skinned mesh's world position is boneMatrix * boneInverse * bindMatrix * position, whatever its own transform.
 */
export function packSkinned(root: THREE.Object3D, surface: (m: THREE.Material) => Surface | null): void {
  root.updateMatrixWorld(true);
  const groups = new Map<string, { skeleton: THREE.Skeleton; side: THREE.Side; meshes: THREE.SkinnedMesh[]; surfaces: Surface[] }>();
  // the parts left alone that share one material (glass) still merge with each other, material and all
  const alike = new Map<string, { skeleton: THREE.Skeleton; material: THREE.Material; meshes: THREE.SkinnedMesh[] }>();
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || Array.isArray(m.material)) return;
    const s = surface(m.material);
    if (!s) {
      const key = `${m.skeleton.uuid}:${m.material.uuid}`;
      let g = alike.get(key);
      if (!g) alike.set(key, g = { skeleton: m.skeleton, material: m.material, meshes: [] });
      g.meshes.push(m);
      return;
    }
    const key = `${m.skeleton.uuid}:${m.material.side}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { skeleton: m.skeleton, side: m.material.side, meshes: [], surfaces: [] });
    g.meshes.push(m);
    g.surfaces.push(s);
  });
  for (const g of groups.values()) {
    if (g.meshes.length < 2) continue;
    const geometry = packGeometry(g.meshes.map((m, i) => ({ geometry: m.geometry, matrix: m.bindMatrix, surface: g.surfaces[i] })));
    if (!geometry) continue;
    const mesh = new THREE.SkinnedMesh(geometry, new PackedMaterial({ side: g.side }));
    mesh.name = 'packed';
    mesh.bind(g.skeleton, new THREE.Matrix4());
    g.meshes[0].parent!.add(mesh);
    for (const m of g.meshes) { m.removeFromParent(); m.geometry.dispose(); }
  }
  for (const g of alike.values()) {
    if (g.meshes.length < 2) continue;
    const gs = g.meshes.map((m) => { const p = plain(m.geometry); p.applyMatrix4(m.bindMatrix); return p; });
    const geometry = mergeGeometries(gs, false);
    for (const p of gs) p.dispose();
    if (!geometry) continue;
    const mesh = new THREE.SkinnedMesh(geometry, g.material);
    mesh.name = g.meshes[0].name;
    mesh.bind(g.skeleton, new THREE.Matrix4());
    g.meshes[0].parent!.add(mesh);
    for (const m of g.meshes) { m.removeFromParent(); m.geometry.dispose(); }
  }
}

/** Fold every mesh under `root` into one packed mesh in root's own space (a static prop: a plinth). */
export function packStatic(root: THREE.Object3D, surface: (o: THREE.Mesh) => Surface): THREE.Mesh | null {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const parts: Array<{ geometry: THREE.BufferGeometry; matrix: THREE.Matrix4; surface: Surface }> = [];
  let side: THREE.Side = THREE.FrontSide;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    side = m.material.side;
    parts.push({ geometry: m.geometry, matrix: inv.clone().multiply(m.matrixWorld), surface: surface(m) });
  });
  const geometry = parts.length ? packGeometry(parts) : null;
  if (!geometry) return null;
  const mesh = new THREE.Mesh(geometry, new PackedMaterial({ side }));
  mesh.name = root.name;
  return mesh;
}
