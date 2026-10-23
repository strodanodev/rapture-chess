/**
 * The armies: each piece is a Rapture champion avatar (animated: idle, attack, hit, death) standing on the
 * Blender plinth of its chess type, with the plinth's rune ring lit in the champion's element. Moves glide,
 * captures play out (the attacker strikes, the fallen champion dissolves in a burst), pawns ascend on promotion.
 */
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Move } from 'chess.js';
import type { Card } from '../roster';
import { ELEMENT_COLOR } from '../roster';
import type { PieceType, Side } from '../rules/chessRules';
import { loadAvatar } from './assets';
import { finishAvatarMaterial } from './materials';
import { squareToWorld } from './board';
import { tweens, ease, wait } from './tween';
import type { VFX } from './vfx';

export const PIECE_HEIGHT: Record<PieceType, number> = { p: 0.62, n: 0.78, b: 0.8, r: 0.82, q: 1.0, k: 1.12 };
const PLINTH_TOP: Record<PieceType, number> = { p: 0.1, n: 0.175, b: 0.21, r: 0.19, q: 0.275, k: 0.32 };
/** Blender characters face -Y, which glTF turns into +Z: White (on +Z) turns around to face the Horde. */
const FACING: Record<Side, number> = { 0: Math.PI, 1: 0 };

export class PieceView {
  readonly group = new THREE.Group();
  readonly pick: THREE.Mesh;
  readonly color: THREE.Color;
  private avatar: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private clips = new Map<string, THREE.AnimationAction>();
  private plinth: THREE.Object3D | null = null;
  private rune: THREE.MeshStandardMaterial | null = null;
  private materials: THREE.Material[] = [];
  private idlePhase = Math.random() * 10;
  public square: string;

  constructor(readonly card: Card, public type: PieceType, readonly side: Side, square: string, private readonly plinths: Map<string, THREE.Object3D>) {
    this.square = square;
    this.color = new THREE.Color(ELEMENT_COLOR[card.element]);
    this.group.position.copy(squareToWorld(square));
    this.group.rotation.y = FACING[side];
    this.pick = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.4, 12), new THREE.MeshBasicMaterial({ visible: false }));
    this.pick.position.y = 0.7;
    this.pick.userData.piece = this;
    this.group.add(this.pick);
    this.setPlinth(type);
  }

  private setPlinth(type: PieceType): void {
    if (this.plinth) this.group.remove(this.plinth);
    const src = this.plinths.get(type);
    if (!src) return;
    this.plinth = src.clone(true);
    this.plinth.position.set(0, 0, 0);
    this.plinth.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = o.receiveShadow = true;
      if (/^Rune_/.test(o.name)) {
        this.rune = (o.material as THREE.MeshStandardMaterial).clone();
        this.rune.emissive.copy(this.color);
        this.rune.emissiveIntensity = 1.6;
        o.material = this.rune;
      }
    });
    this.group.add(this.plinth);
    this.type = type;
    if (this.avatar) this.fitAvatar();
  }

  async load(): Promise<void> {
    const gltf = await loadAvatar(this.card.slug).catch(() => null);
    if (!gltf) return;
    const root = SkeletonUtils.clone(gltf.scene);
    this.materials = [];
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.frustumCulled = false; // skinned + quantized bounds are unreliable
      o.castShadow = true;
      const mats = ([] as THREE.Material[]).concat(o.material).map((m) => {
        const c = (m as THREE.MeshStandardMaterial).clone();
        c.name = m.name;
        c.userData = {};
        if (c instanceof THREE.MeshStandardMaterial) finishAvatarMaterial(c, this.color);
        return c;
      });
      o.material = mats.length === 1 ? mats[0] : mats;
      this.materials.push(...mats);
    });
    this.mixer = new THREE.AnimationMixer(root);
    for (const clip of gltf.animations) this.clips.set(clip.name.toLowerCase(), this.mixer.clipAction(clip));
    const idle = this.clips.get('idle');
    if (idle) { idle.play(); this.mixer.setTime(this.idlePhase); }
    this.avatar = root;
    this.group.add(root);
    this.fitAvatar();
  }

  /** Scale the avatar to the piece type's height and stand it on the plinth top. */
  private fitAvatar(): void {
    const root = this.avatar!;
    root.scale.setScalar(1);
    root.position.set(0, 0, 0);
    // measure in the avatar's own space: detached, its world matrix is its local one. (Measured in place, the box
    // carried the square's world position, and avatars that finished loading after their piece stood on the board
    // were thrown off their plinths by that much.)
    const parent = root.parent;
    parent?.remove(root);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root, true), size = box.getSize(new THREE.Vector3());
    parent?.add(root);
    const s = PIECE_HEIGHT[this.type] / (size.y || 1);
    root.scale.setScalar(s);
    root.position.set(-(box.min.x + size.x / 2) * s, PLINTH_TOP[this.type] - box.min.y * s, -(box.min.z + size.z / 2) * s);
    this.pick.scale.y = (PLINTH_TOP[this.type] + PIECE_HEIGHT[this.type]) / 1.4;
    this.pick.position.y = (PLINTH_TOP[this.type] + PIECE_HEIGHT[this.type]) / 2;
  }

  /** Play a clip once at `speed`, then settle back into idle. */
  play(name: string, speed = 1, blend = 0.15): number {
    const a = this.clips.get(name), idle = this.clips.get('idle');
    if (!a || !this.mixer) return 0;
    a.reset().setLoop(THREE.LoopOnce, 1).setEffectiveTimeScale(speed).setEffectiveWeight(1);
    a.clampWhenFinished = true;
    if (idle) a.crossFadeFrom(idle, blend, false);
    a.play();
    const seconds = a.getClip().duration / speed;
    if (idle) setTimeout(() => { if (this.mixer) { idle.enabled = true; idle.reset().setEffectiveWeight(1).play(); idle.crossFadeFrom(a, 0.3, false); } }, Math.max(0, seconds * 1000 - 300));
    return seconds;
  }

  setHighlight(on: boolean): void { if (this.rune) this.rune.emissiveIntensity = on ? 4.5 : 1.6; }

  update(dt: number, t: number): void {
    this.mixer?.update(dt);
    if (this.rune && this.rune.emissiveIntensity <= 1.6) this.rune.emissiveIntensity = 1.4 + 0.35 * Math.sin(t * 2.2 + this.idlePhase);
  }

  /** Glide to a square along an arc (knights leap higher). */
  async moveTo(square: string, leap = false, vfx?: VFX): Promise<void> {
    const from = this.group.position.clone(), to = squareToWorld(square);
    this.square = square;
    const h = leap ? 1.1 : 0.35, d = from.distanceTo(to);
    const trail = vfx?.trail(this.color);
    await tweens.run(0.42 + Math.min(0.3, d * 0.04), (k) => {
      this.group.position.lerpVectors(from, to, k);
      this.group.position.y = Math.sin(k * Math.PI) * h;
      if (trail) { trail.emitter.position.copy(this.group.position); trail.emitter.position.y += PLINTH_TOP[this.type] + 0.3; }
    }, ease.inOutCubic);
    trail?.stop();
    this.group.position.copy(to);
  }

  /** The champion falls: a hit, then a dissolve. Resolves when the piece is gone. */
  async fall(vfx: VFX): Promise<void> {
    this.play('hit', 1.4);
    await wait(0.25);
    vfx.burst(this.group.position, this.color, this.side === 0);
    this.play('death', 2.2);
    for (const m of this.materials) { m.transparent = true; m.depthWrite = false; }
    await tweens.run(0.7, (k) => {
      for (const m of this.materials) (m as THREE.MeshStandardMaterial).opacity = 1 - k;
      if (this.rune) this.rune.emissiveIntensity = 6 * (1 - k);
      this.group.position.y = -0.25 * k;
      this.group.scale.setScalar(1 - 0.15 * k);
    }, ease.inOutCubic);
    this.dispose();
  }

  /** A pawn reaches the last rank and ascends to its new seat. */
  async ascend(to: PieceType, vfx: VFX): Promise<void> {
    vfx.ascension(this.group.position, this.color);
    this.play('attack', 1.3);
    await tweens.run(0.5, (k) => { this.group.scale.setScalar(1 - 0.5 * k); }, ease.inOutCubic);
    this.setPlinth(to);
    await tweens.run(0.6, (k) => { this.group.scale.setScalar(0.5 + 0.5 * k); }, ease.outBack);
    this.group.scale.setScalar(1);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of this.materials) m.dispose();
    this.mixer?.stopAllAction();
  }
}

export class Army {
  readonly group = new THREE.Group();
  readonly pieces = new Map<string, PieceView>();

  constructor(private readonly plinths: Map<string, THREE.Object3D>, private readonly vfx: VFX) {}

  /** Seat a side's roster on its starting squares and load the avatars. */
  async muster(side: Side, roster: Map<string, Card>, types: Map<string, PieceType>): Promise<void> {
    const loads: Promise<void>[] = [];
    for (const [sq, card] of roster) {
      const p = new PieceView(card, types.get(sq) ?? 'p', side, sq, this.plinths);
      this.pieces.set(sq, p);
      this.group.add(p.group);
      loads.push(p.load());
    }
    await Promise.all(loads);
  }

  at(square: string): PieceView | undefined { return this.pieces.get(square); }
  pickables(): THREE.Object3D[] { return [...this.pieces.values()].map((p) => p.pick); }

  update(dt: number, t: number): void { for (const p of this.pieces.values()) p.update(dt, t); }

  /** Play a chess.js move out on the board. Resolves when the animation is over. */
  async apply(move: Move): Promise<void> {
    const piece = this.pieces.get(move.from);
    if (!piece) return;
    this.pieces.delete(move.from);
    const victimSquare = move.flags.includes('e') ? `${move.to[0]}${move.from[1]}` : move.to;
    const victim = move.captured ? this.pieces.get(victimSquare) : undefined;
    if (victim) this.pieces.delete(victimSquare);
    this.pieces.set(move.to, piece);
    const castle = move.flags.includes('k') ? { from: `h${move.from[1]}`, to: `f${move.from[1]}` } : move.flags.includes('q') ? { from: `a${move.from[1]}`, to: `d${move.from[1]}` } : null;
    const rook = castle ? this.pieces.get(castle.from) : undefined;
    if (rook && castle) { this.pieces.delete(castle.from); this.pieces.set(castle.to, rook); }

    const jobs: Promise<void>[] = [piece.moveTo(move.to, move.piece === 'n', this.vfx)];
    if (rook && castle) jobs.push(rook.moveTo(castle.to, false, this.vfx));
    await Promise.all(jobs);
    if (victim) {
      piece.play('attack', 1.6);
      await victim.fall(this.vfx);
    } else {
      this.vfx.landing(piece.group.position, piece.color);
    }
    if (move.promotion) await piece.ascend(move.promotion as PieceType, this.vfx);
  }

  clear(): void {
    for (const p of this.pieces.values()) p.dispose();
    this.pieces.clear();
  }
}
