/**
 * Role marks: a chess glyph over every champion, so each one's role reads at a glance (the avatars alone are hard to
 * tell apart), white for the Alliance and black for the Horde. The marks are DOM buttons over the canvas, projected
 * each frame. Where champions stand in line with the camera their marks would stack, so overlapping marks are pushed
 * apart (the one further back gives way, upwards) and a leader line ties a displaced mark to its champion's head.
 * They are also handles: main.ts selects on press and moves the champion while one is dragged.
 */
import * as THREE from 'three';
import type { PieceView } from '../scene/pieces';
import type { PieceType, Side } from '../rules/chessRules';
import { PIECE_NAME } from '../roster';
import { GLYPH } from './glyphs';
import { h } from './dom';

const BOX = 48;              // the button's layout size; it is scaled to the size the board is drawn at
const RELAX_STEPS = 8;
const SVG_NS = 'http://www.w3.org/2000/svg';

interface Mark {
  el: HTMLButtonElement; line: SVGLineElement; type: PieceType | null; flags: string;
  on: boolean; ax: number; ay: number; px: number; py: number; ox: number; oy: number; r: number; size: number; depth: number;
  shown: string; z: number; led: boolean;
}

export class RoleMarks {
  readonly el = h('div', { class: 'marks', hidden: true });
  private readonly lines = document.createElementNS(SVG_NS, 'svg');
  private readonly marks = new Map<PieceView, Mark>();
  private readonly v = new THREE.Vector3();
  private visible = false;
  /** The player's side: their own marks are the draggable ones. */
  you: Side = 0;
  enabled = true;
  /** The champion being dragged: its mark holds still and the others make way. */
  held: PieceView | null = null;
  selected: PieceView | null = null;
  /** Squares the selected champion can capture on. */
  targets = new Set<string>();
  check: PieceView | null = null;
  onPress: (piece: PieceView, ev: PointerEvent, el: HTMLElement) => void = () => {};

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly canvas: HTMLCanvasElement) {
    this.lines.setAttribute('class', 'mark-lines');
    this.lines.setAttribute('aria-hidden', 'true');
    this.el.append(this.lines);
  }

  private add(piece: PieceView): Mark {
    const el = h('button', { class: 'mark', type: 'button', tabIndex: -1 });
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.onPress(piece, ev, el);
    });
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    const line = document.createElementNS(SVG_NS, 'line');
    line.style.display = 'none';
    this.lines.append(line);
    this.el.append(el);
    const m: Mark = { el, line, type: null, flags: '', on: false, ax: 0, ay: 0, px: 0, py: 0, ox: 0, oy: 0, r: 0, size: 0, depth: 0, shown: '', z: 0, led: false };
    this.marks.set(piece, m);
    return m;
  }

  /** Project, de-overlap and draw the marks for `pieces` (once per frame). */
  update(pieces: Iterable<PieceView>, show: boolean, dt: number): void {
    show &&= this.enabled;
    if (show !== this.visible) { this.visible = show; this.el.hidden = !show; }
    if (!show) return;
    const cam = this.camera, w = this.canvas.clientWidth, ht = this.canvas.clientHeight;
    cam.updateMatrixWorld();
    // pixels per metre at distance 1: a mark is half a square wide, kept between a fingertip and a thumbnail
    const ppm = ht / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const min = Math.min(w, ht) < 560 ? 26 : 22, max = 46;

    const live = new Set<PieceView>();
    const list: Mark[] = [];
    for (const piece of pieces) {
      live.add(piece);
      const m = this.marks.get(piece) ?? this.add(piece);
      if (m.type !== piece.type) {
        m.type = piece.type;
        m.el.innerHTML = GLYPH[piece.type]; // developer-authored SVG only
        m.el.setAttribute('aria-label', `${piece.side === 0 ? 'White' : 'Black'} ${PIECE_NAME[piece.type]}, ${piece.card.name}`);
      }
      const flags = `mark ${piece.side === 0 ? 'w' : 'b'}${piece.side === this.you ? ' mine' : ''}${piece === this.selected ? ' sel' : ''}${piece !== this.selected && this.selected && this.targets.has(piece.square) ? ' hit' : ''}${piece === this.check ? ' check' : ''}${piece === this.held ? ' held' : ''}`;
      if (flags !== m.flags) { m.flags = flags; m.el.className = flags; }
      const v = piece.crown(this.v);
      m.depth = v.distanceTo(cam.position);
      v.project(cam);
      m.on = v.z < 1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15;
      if (!m.on) continue;
      m.ax = m.px = (v.x + 1) / 2 * w;
      m.ay = m.py = (1 - v.y) / 2 * ht;
      m.size = Math.min(max, Math.max(min, (0.5 * ppm) / m.depth));
      m.r = m.size / 2 + 1.5;
      list.push(m);
    }
    for (const [piece, m] of this.marks) if (!live.has(piece)) { m.el.remove(); m.line.remove(); this.marks.delete(piece); }

    // push overlapping marks apart. The one further from the camera gives way (its champion is the one standing
    // behind), and the push leans upwards, so the back mark lifts over the front one rather than sliding sideways.
    const held = this.held ? this.marks.get(this.held) : undefined;
    for (let step = 0; step < RELAX_STEPS; step++) {
      let moved = false;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        let near = list[i], far = list[j];
        if (near.depth > far.depth) [near, far] = [far, near];
        let dx = far.px - near.px, dy = far.py - near.py;
        const reach = near.r + far.r;
        if (Math.abs(dx) >= reach || Math.abs(dy) >= reach) continue;
        let d = Math.hypot(dx, dy);
        if (d >= reach) continue;
        if (d < 0.01) { dx = 0; dy = -1; d = 1; }
        let nx = dx / d, ny = dy / d - 0.6;
        const n = Math.hypot(nx, ny) || 1;
        nx /= n; ny /= n;
        const push = reach - d;
        const kf = far === held ? 0 : near === held ? 1 : 0.8;
        far.px += nx * push * kf; far.py += ny * push * kf;
        near.px -= nx * push * (1 - kf); near.py -= ny * push * (1 - kf);
        moved = true;
      }
      if (!moved) break;
    }

    // ease the offsets (not the positions: the marks stay glued to the champions while the camera moves)
    const k = 1 - Math.exp(-dt * 16);
    for (const m of this.marks.values()) {
      if (!m.on) { if (m.shown !== 'off') { m.shown = 'off'; m.el.style.visibility = 'hidden'; m.line.style.display = 'none'; m.led = false; } continue; }
      m.ox += (m.px - m.ax - m.ox) * k;
      m.oy += (m.py - m.ay - m.oy) * k;
      const x = m.ax + m.ox, y = m.ay + m.oy;
      const t = `translate3d(${(x - BOX / 2).toFixed(1)}px,${(y - BOX / 2).toFixed(1)}px,0) scale(${(m.size / BOX).toFixed(3)})`;
      if (t !== m.shown) { if (m.shown === 'off' || !m.shown) m.el.style.visibility = ''; m.shown = t; m.el.style.transform = t; }
      const z = 1000 - Math.round(m.depth * 20);
      if (z !== m.z) { m.z = z; m.el.style.zIndex = String(z); }
      const off = Math.hypot(m.ox, m.oy), lead = off > m.r * 1.1; // the head is out from under the mark
      if (lead !== m.led) { m.led = lead; m.line.style.display = lead ? '' : 'none'; }
      if (lead) {
        const e = (off - m.r * 0.85) / off; // stop at the mark's rim
        m.line.setAttribute('x1', m.ax.toFixed(1)); m.line.setAttribute('y1', m.ay.toFixed(1));
        m.line.setAttribute('x2', (m.ax + m.ox * e).toFixed(1)); m.line.setAttribute('y2', (m.ay + m.oy * e).toFixed(1));
      }
    }
  }
}
