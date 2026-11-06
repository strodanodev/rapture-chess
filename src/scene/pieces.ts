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
import { finishAvatarMaterial, packAvatar } from './materials';
import { isPacked, type PackedMaterial } from './packed';
import { squareToWorld } from './board';
import { tweens, ease, wait } from './tween';
import type { VFX } from './vfx';

export const PIECE_HEIGHT: Record<PieceType, number> = { p: 0.62, n: 0.78, b: 0.8, r: 0.82, q: 1.0, k: 1.12 };
const PLINTH_TOP: Record<PieceType, number> = { p: 0.1, n: 0.175, b: 0.21, r: 0.19, q: 0.275, k: 0.32 };
/** Blender characters face -Y, which glTF turns into +Z: White (on +Z) turns around to face the Horde. */
const FACING: Record<Side, number> = { 0: Math.PI, 1: 0 };

/** Beats of a move as it plays out, for the sound: a slide, a knight's leap or a castling starts; a piece lands;
 *  the attacker strikes (the victim falls 0.25 s later); a pawn ascends. */
export type Cue = 'move' | 'leap' | 'castle' | 'land' | 'strike' | 'ascend';

/** Avatar files already packed (once per file: every piece cloned from it shares the packed geometry). */
const packed = new WeakSet<object>();

export class PieceView {
  readonly group = new THREE.Group();
  readonly pick: THREE.Mesh;
  readonly color: THREE.Color;
  private avatar: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private clips = new Map<string, THREE.AnimationAction>();
  private plinth: THREE.Object3D | null = null;
  /** This piece's own copy of the packed plinth material: its rune burns in the champion's element. */
  private plinthMat: PackedMaterial | null = null;
  /** The rune's brightness; it breathes unless the piece is highlighted or falling. */
  private runeLevel = 1.6;
  private runeHeld = false;
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
    const src = this.plinths.get(type) as THREE.Mesh | undefined;
    if (!src) return;
    // the plinth is one packed mesh (stone, gold cap, rune): share its geometry, own the material for the rune colour
    const plinth = src.clone(true);
    plinth.position.set(0, 0, 0);
    plinth.castShadow = plinth.receiveShadow = true;
    this.plinthMat?.dispose();
    this.plinthMat = isPacked(src.material as THREE.Material) ? (src.material as PackedMaterial).clone() : null;
    if (this.plinthMat) plinth.material = this.plinthMat;
    this.plinth = plinth;
    this.glow(this.runeLevel);
    this.group.add(plinth);
    this.type = type;
    if (this.avatar) this.fitAvatar();
  }

  /** Set the rune ring's brightness (the element colour times `level`). */
  private glow(level: number): void {
    this.runeLevel = level;
    this.plinthMat?.rune.value.copy(this.color).multiplyScalar(level);
  }

  async load(): Promise<void> {
    const gltf = await loadAvatar(this.card.slug).catch(() => null);
    if (!gltf) return;
    if (!packed.has(gltf)) { packAvatar(gltf.scene); packed.add(gltf); }
    const root = SkeletonUtils.clone(gltf.scene);
    this.materials = [];
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.frustumCulled = false; // skinned + quantized bounds are unreliable
      o.castShadow = true;
      // the packed body is already finished (its surface is in the vertices): a plain copy, for this piece's fade
      const mats = ([] as THREE.Material[]).concat(o.material).map((m) => {
        const c = (m as THREE.MeshStandardMaterial).clone();
        c.name = m.name;
        c.userData = {};
        if (c instanceof THREE.MeshStandardMaterial && !isPacked(c)) finishAvatarMaterial(c, this.color);
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

  setHighlight(on: boolean): void { this.runeHeld = on; this.glow(on ? 4.5 : 1.6); }

  /** The point just over the champion's head, in world space: where its role mark hangs. */
  crown(target: THREE.Vector3): THREE.Vector3 {
    const p = this.group.position;
    return target.set(p.x, p.y + (PLINTH_TOP[this.type] + PIECE_HEIGHT[this.type] + 0.12) * this.group.scale.y, p.z);
  }

  update(dt: number, t: number): void {
    this.mixer?.update(dt);
    if (!this.runeHeld) this.glow(1.4 + 0.35 * Math.sin(t * 2.2 + this.idlePhase));
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
    this.runeHeld = true;
    for (const m of this.materials) { m.transparent = true; m.depthWrite = false; }
    await tweens.run(0.7, (k) => {
      for (const m of this.materials) (m as THREE.MeshStandardMaterial).opacity = 1 - k;
      this.glow(6 * (1 - k));
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
    this.plinthMat?.dispose();
    this.mixer?.stopAllAction();
  }
}

export class Army {
  readonly group = new THREE.Group();
  readonly pieces = new Map<string, PieceView>();
  /** Told each beat of a move as it plays (see Cue). */
  onCue: ((cue: Cue, piece: PieceView) => void) | null = null;

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

  /**
   * Replace every piece with a new set, built off the board: the avatars load and `ready` prepares them (compiles their
   * shaders) while the old pieces stand, then the swap happens in one frame. The old materials are freed only after
   * the new ones hold their programs, so no program is thrown away and rebuilt. Builds nothing if `stale()` turns true.
   */
  async replace(sides: Array<{ side: Side; roster: Map<string, Card>; types: Map<string, PieceType> }>, ready: (staged: THREE.Object3D) => Promise<void>, stale: () => boolean): Promise<boolean> {
    const staged = new THREE.Group();
    const next = new Map<string, PieceView>();
    for (const { side, roster, types } of sides) for (const [sq, card] of roster) {
      const p = new PieceView(card, types.get(sq) ?? 'p', side, sq, this.plinths);
      next.set(sq, p);
      staged.add(p.group);
    }
    await Promise.all([...next.values()].map((p) => p.load()));
    if (!stale()) await ready(staged);
    if (stale()) { for (const p of next.values()) p.dispose(); return false; }
    this.clear();
    for (const [sq, p] of next) { this.pieces.set(sq, p); this.group.add(p.group); }
    return true;
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

    this.onCue?.(rook ? 'castle' : move.piece === 'n' ? 'leap' : 'move', piece);
    const jobs: Promise<void>[] = [piece.moveTo(move.to, move.piece === 'n', this.vfx)];
    if (rook && castle) jobs.push(rook.moveTo(castle.to, false, this.vfx));
    await Promise.all(jobs);
    if (victim) {
      piece.play('attack', 1.6);
      this.onCue?.('strike', piece);
      await victim.fall(this.vfx);
    } else {
      this.vfx.landing(piece.group.position, piece.color);
      if (!rook) this.onCue?.('land', piece);   // castling's own sound sets both pieces down
    }
    if (move.promotion) { this.onCue?.('ascend', piece); await piece.ascend(move.promotion as PieceType, this.vfx); }
  }

  clear(): void {
    for (const p of this.pieces.values()) p.dispose();
    this.pieces.clear();
  }
}
