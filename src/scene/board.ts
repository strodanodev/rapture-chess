/** The Blender board on stage, plus square highlights: selection, legal targets, the last move, check and hover. */
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { boardMaterials } from './materials';
import { softParticleTexture } from './assets';
import { FILES } from '../rules/chessRules';

export const squareToWorld = (sq: string, y = 0): THREE.Vector3 => new THREE.Vector3(FILES.indexOf(sq[0]) - 3.5, y, 3.5 - (Number(sq[1]) - 1));
export const worldToSquare = (p: THREE.Vector3): string | null => {
  const f = Math.round(p.x + 3.5), r = Math.round(3.5 - p.z);
  return f >= 0 && f < 8 && r >= 0 && r < 8 ? `${FILES[f]}${r + 1}` : null;
};

type Marker = { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial };

export class BoardView {
  readonly group = new THREE.Group();
  readonly plinths = new Map<string, THREE.Object3D>();
  readonly pickPlane: THREE.Mesh;
  readonly materials = boardMaterials();
  private readonly targets: Marker[] = [];
  private readonly selected: Marker;
  private readonly hover: Marker;
  private readonly last: [Marker, Marker];
  private readonly check: Marker;
  private t = 0;

  constructor(set: GLTF) {
    const root = set.scene;
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const name = (o.material as THREE.Material).name;
      if (this.materials[name]) o.material = this.materials[name];
      o.castShadow = !/Board_/.test(o.name);
      o.receiveShadow = true;
    });
    for (const k of ['P', 'N', 'B', 'R', 'Q', 'K']) {
      const p = root.getObjectByName(`Plinth_${k}`);
      if (p) { p.removeFromParent(); this.plinths.set(k.toLowerCase(), p); }
    }
    root.getObjectByName('Plinths')?.removeFromParent();
    this.group.add(root);

    this.pickPlane = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshBasicMaterial({ visible: false }));
    this.pickPlane.rotation.x = -Math.PI / 2;
    this.pickPlane.position.y = 0.001;
    this.group.add(this.pickPlane);

    const disc = new THREE.CircleGeometry(0.17, 32), ring = new THREE.RingGeometry(0.36, 0.44, 48), square = new THREE.PlaneGeometry(0.96, 0.96);
    const mk = (geo: THREE.BufferGeometry, color: number, opacity = 0.8): Marker => {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.012;
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      return { mesh, mat };
    };
    for (let i = 0; i < 32; i++) this.targets.push(mk(disc, 0xffd27a, 0.75));
    for (const m of this.targets) m.mesh.userData.ring = new THREE.Mesh(ring, m.mat); // capture markers reuse the material
    this.selected = mk(square, 0xffc455, 0.35);
    this.hover = mk(square, 0xffc455, 0.1);
    this.hover.mat.blending = THREE.NormalBlending;
    this.last = [mk(square, 0x6ea0ff, 0.16), mk(square, 0x6ea0ff, 0.22)];
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8), new THREE.MeshBasicMaterial({ map: softParticleTexture(), color: 0xff3030, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.015; glow.visible = false; glow.renderOrder = 2;
    this.group.add(glow);
    this.check = { mesh: glow, mat: glow.material as THREE.MeshBasicMaterial };
  }

  /** Legal destinations for the selected piece; `captures` are drawn as rings instead of discs. */
  showTargets(squares: string[], captures: Set<string>): void {
    this.targets.forEach((m, i) => {
      const sq = squares[i];
      m.mesh.visible = !!sq;
      if (!sq) return;
      m.mesh.position.copy(squareToWorld(sq, 0.012));
      m.mesh.geometry = captures.has(sq) ? (m.mesh.userData.ring as THREE.Mesh).geometry : (this.targets[0].mesh.userData.disc ??= new THREE.CircleGeometry(0.17, 32));
      m.mat.color.set(captures.has(sq) ? 0xff6a4a : 0xffd27a);
    });
  }
  clearTargets(): void { for (const m of this.targets) m.mesh.visible = false; }
  setSelected(sq: string | null): void { this.place(this.selected, sq); }
  setHover(sq: string | null): void { this.place(this.hover, sq); }
  setLastMove(from: string | null, to: string | null): void { this.place(this.last[0], from); this.place(this.last[1], to); }
  setCheck(sq: string | null): void { this.place(this.check, sq); }
  private place(m: Marker, sq: string | null): void {
    m.mesh.visible = !!sq;
    if (sq) { const y = m.mesh.position.y; m.mesh.position.copy(squareToWorld(sq, y)); }
  }

  update(dt: number): void {
    this.t += dt;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4);
    for (const m of this.targets) if (m.mesh.visible) m.mat.opacity = 0.55 + 0.3 * pulse;
    this.selected.mat.opacity = 0.28 + 0.14 * pulse;
    this.check.mat.opacity = 0.45 + 0.45 * pulse;
    this.check.mesh.scale.setScalar(1 + 0.08 * pulse);
  }
}
