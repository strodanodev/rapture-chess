/**
 * Fire and lightning on the menu title. A small transparent three.js canvas over the title image (its own renderer,
 * an orthographic camera in CSS pixels, no post-processing), so it draws above the title and costs next to nothing:
 *   - flames and embers (three.quarks) rise off the tops of the letters, emitted from points sampled out of the
 *     title image's own alpha, so they follow the real letter shapes;
 *   - lightning, generated: a bolt arcs between two letters or strikes down onto one from above, flickering through a
 *     few fresh paths before it dies, with a flash and a spray of sparks where it lands, and the title lights blue.
 * It runs only while the menu is on screen (start/stop) and not at all with reduced motion.
 */
import * as THREE from 'three';
import {
  BatchedRenderer, ParticleSystem, RenderMode, ConstantValue, IntervalValue, ConstantColor, ColorOverLife, Gradient, SizeOverLife,
  PiecewiseBezier, Bezier, ApplyForce, MeshSurfaceEmitter, PointEmitter, Vector3 as QVector3, Vector4 as QVector4,
} from 'three.quarks';
import { softParticleTexture } from '../scene/assets';

type P = { x: number; y: number };
const coarse = matchMedia('(pointer: coarse)').matches;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const v3 = (r: number, g: number, b: number) => new QVector3(r, g, b);

/** A soft band across the width of a ribbon: white core, electric blue glow, clear edges. */
function boltTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 2;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 64, 0);
  grd.addColorStop(0, 'rgba(90,140,255,0)');
  grd.addColorStop(0.3, 'rgba(110,165,255,0.35)');
  grd.addColorStop(0.44, 'rgba(185,215,255,0.9)');
  grd.addColorStop(0.5, 'rgba(255,255,255,1)');
  grd.addColorStop(0.56, 'rgba(185,215,255,0.9)');
  grd.addColorStop(0.7, 'rgba(110,165,255,0.35)');
  grd.addColorStop(1, 'rgba(90,140,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A flame tongue: a teardrop, rounded and hottest low, tapering to a point at the top. */
function flameTexture(): THREE.Texture {
  const s = 64, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.translate(s / 2, s * 0.68);
  g.scale(1, 1.9);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, s * 0.3);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(0, -s * 0.34);
  g.bezierCurveTo(s * 0.12, -s * 0.18, s * 0.26, -s * 0.04, s * 0.26, s * 0.06);
  g.arc(0, s * 0.06, s * 0.26, 0, Math.PI);
  g.bezierCurveTo(-s * 0.26, -s * 0.04, -s * 0.12, -s * 0.18, 0, -s * 0.34);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A jagged path from a to b, bowed through `bow`: a few curve samples, then midpoint displacement. */
function boltPath(a: P, b: P, bow: P | null, gens: number, rough: number): P[] {
  let pts: P[] = [];
  if (bow) for (let i = 0; i <= 6; i++) {
    const t = i / 6, u = 1 - t;
    pts.push({ x: u * u * a.x + 2 * u * t * bow.x + t * t * b.x, y: u * u * a.y + 2 * u * t * bow.y + t * t * b.y });
  } else pts = [a, b];
  let off = Math.hypot(b.x - a.x, b.y - a.y) * rough;
  for (let g = 0; g < gens; g++) {
    const next: P[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i], dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1, d = rand(-off, off);
      next.push({ x: (p.x + q.x) / 2 - (dy / len) * d, y: (p.y + q.y) / 2 + (dx / len) * d }, q);
    }
    pts = next;
    off *= 0.55;
  }
  return pts;
}

/** Ribbon quads along polylines, `u` across the width (the band texture), as one geometry. */
function ribbons(paths: Array<{ pts: P[]; width: number }>): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  for (const { pts, width } of paths) {
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i], dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
      // taper toward the end of the path
      const w0 = (width / 2) * (1 - (i - 1) / pts.length * 0.6), w1 = (width / 2) * (1 - i / pts.length * 0.6);
      const nx = -dy / len, ny = dx / len;
      const a = [p.x + nx * w0, p.y + ny * w0], b = [p.x - nx * w0, p.y - ny * w0], c = [q.x + nx * w1, q.y + ny * w1], d = [q.x - nx * w1, q.y - ny * w1];
      pos.push(a[0], a[1], 0, b[0], b[1], 0, c[0], c[1], 0, b[0], b[1], 0, d[0], d[1], 0, c[0], c[1], 0);
      uv.push(0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

export class TitleFX {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
  private readonly batch = new BatchedRenderer();
  private systems: ParticleSystem[] = [];
  private tops: P[] = [];        // letter tops (canvas px, y up), RAPTURE first
  private upper: P[] = [];       // the tops of RAPTURE alone
  private scale = 1;             // the title's width / 440 px
  private w = 1; private h = 1;
  private running = false;
  private last = 0;
  private nextStrike = 1.2;
  private clock = 0;
  private bolt: { mesh: THREE.Mesh; a: P; b: P; bow: P | null; age: number; life: number; flick: number; branches: number } | null = null;
  private flash: THREE.Mesh;
  private flashAge = 1;
  private readonly boltMat: THREE.MeshBasicMaterial;
  private readonly soft: THREE.MeshBasicMaterial;
  private readonly flameMat: THREE.MeshBasicMaterial;
  private sparks: ParticleSystem | null = null;
  private resizeT = 0;

  constructor(private readonly host: HTMLElement, private readonly img: HTMLImageElement) {
    this.canvas.className = 'title-fx';
    this.canvas.setAttribute('aria-hidden', 'true');
    host.append(this.canvas);
    this.scene.add(this.batch);
    this.boltMat = new THREE.MeshBasicMaterial({ map: boltTexture(), transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false });
    this.soft = new THREE.MeshBasicMaterial({ map: softParticleTexture(), transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false });
    this.flameMat = new THREE.MeshBasicMaterial({ map: flameTexture(), transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.soft.clone());
    (this.flash.material as THREE.MeshBasicMaterial).color.setRGB(0.6, 0.8, 1.0);
    this.flash.visible = false;
    this.scene.add(this.flash);
    new ResizeObserver(() => { clearTimeout(this.resizeT); this.resizeT = window.setTimeout(() => this.layout(), 120); }).observe(host);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.ready().then(() => {
      if (!this.running) return;
      this.layout();   // the menu may have been laid out (or resized) since the renderer was made
      this.last = performance.now();
      this.renderer!.setAnimationLoop(() => this.tick());
    });
  }

  stop(): void {
    this.running = false;
    this.renderer?.setAnimationLoop(null);
  }

  private async ready(): Promise<void> {
    if (this.renderer) return;
    // wait for the pixels (img.decode() can stay pending on this element in Chromium even once it has loaded)
    if (!this.img.complete || !this.img.naturalWidth) await new Promise((r) => this.img.addEventListener('load', r, { once: true }));
    if (this.renderer) return;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: false, powerPreference: 'low-power', premultipliedAlpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.layout();
  }

  /** Size the canvas, map the title into it, sample the letters and (re)build the emitters. */
  private layout(): void {
    if (!this.renderer) return;
    const cr = this.canvas.getBoundingClientRect(), tr = this.img.getBoundingClientRect();
    // not laid out yet (the menu is still coming in): try again next frame, for as long as it is meant to run
    if (!cr.width || !tr.width) { if (this.running) requestAnimationFrame(() => this.layout()); return; }
    this.w = cr.width; this.h = cr.height;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.25 : 1.5));
    this.renderer.setSize(this.w, this.h, false);
    Object.assign(this.camera, { left: 0, right: this.w, top: this.h, bottom: 0 });
    this.camera.updateProjectionMatrix();
    this.scale = tr.width / 440;
    // the letters' tops: where a column of the title image turns opaque with open air above it
    const sw = 400, sh = Math.round(sw * this.img.naturalHeight / this.img.naturalWidth);
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(this.img, 0, 0, sw, sh);
    const a = g.getImageData(0, 0, sw, sh).data;
    // above the image is open air (the lockup is cropped tight, so RAPTURE's cap line is at its very top)
    const at = (x: number, y: number) => (y < 0 ? 0 : a[(y * sw + x) * 4 + 3]);
    const clear = Math.round(sh * 0.1);
    const tx = tr.left - cr.left, ty = tr.top - cr.top;
    this.tops = []; this.upper = [];
    for (let x = 1; x < sw - 1; x++) {
      for (let y = 0; y < sh; y++) {
        if (at(x, y) < 150) continue;
        let open = true;
        for (let k = 1; k <= clear && open; k++) if (at(x, y - k) > 40) open = false;
        if (!open) continue;
        const p = { x: tx + (x / sw) * tr.width, y: this.h - (ty + (y / sh) * tr.height) };
        this.tops.push(p);
        if (y / sh < 0.55) this.upper.push(p);
        break;
      }
    }
    // the fire crowns RAPTURE: keep the tops on (or near) its cap line, not the slopes of the A or the R's leg or the
    // CHESS horns below, and lift them a little so the flames start above the gold instead of washing over it (both
    // measured on the width: the lockup's height is mostly the CHESS mark)
    const cap = Math.max(...this.upper.map((p) => p.y));
    this.upper = this.upper.filter((p) => cap - p.y < tr.width * 0.03).map((p) => ({ x: p.x, y: p.y + tr.width * 0.008 }));
    this.build();
  }

  private build(): void {
    for (const s of this.systems) { this.batch.deleteSystem(s); this.scene.remove(s.emitter); }
    this.systems = [];
    if (!this.upper.length) return;
    const k = this.scale, density = coarse ? 0.6 : 1;
    // the flames come off RAPTURE; CHESS sits right under it and only gives embers
    const fireSeeds = this.seeds(this.upper);
    // the flame tongues: big soft sprites launched upward, yellow to orange to a dark red as they thin out
    const flames = new ParticleSystem({
      duration: 1, looping: true, worldSpace: false, prewarm: true,
      startLife: new IntervalValue(0.5, 0.95), startSpeed: new IntervalValue(16 * k, 42 * k), startSize: new IntervalValue(22 * k, 40 * k),
      startRotation: new IntervalValue(-0.25, 0.25), startColor: new ConstantColor(new QVector4(1, 0.9, 0.6, 1)),
      emissionOverTime: new ConstantValue(230 * density * Math.min(1.4, k)),
      shape: new MeshSurfaceEmitter(fireSeeds),
      behaviors: [
        new ApplyForce(v3(0, 1, 0), new ConstantValue(70 * k)),
        new ColorOverLife(new Gradient(
          [[v3(1, 0.86, 0.45), 0], [v3(1, 0.5, 0.1), 0.35], [v3(0.75, 0.14, 0.02), 0.75], [v3(0.25, 0.03, 0.01), 1]],
          [[0, 0], [0.6, 0.16], [0.36, 0.55], [0, 1]])),
        new SizeOverLife(new PiecewiseBezier([[new Bezier(0.6, 1, 0.8, 0.15), 0]])),
      ],
      // a teardrop sprite kept upright: tongues of flame rather than round puffs
      material: this.flameMat, renderMode: RenderMode.BillBoard, renderOrder: 2,
    });
    // the hot core along the letter tops: small, short-lived, nearly white
    const core = new ParticleSystem({
      duration: 1, looping: true, worldSpace: false, prewarm: true,
      startLife: new IntervalValue(0.25, 0.45), startSpeed: new IntervalValue(14 * k, 30 * k), startSize: new IntervalValue(6 * k, 11 * k),
      startColor: new ConstantColor(new QVector4(1, 0.95, 0.8, 1)), emissionOverTime: new ConstantValue(130 * density * Math.min(1.4, k)),
      shape: new MeshSurfaceEmitter(fireSeeds),
      behaviors: [
        new ColorOverLife(new Gradient([[v3(1, 0.97, 0.85), 0], [v3(1, 0.7, 0.25), 1]], [[0, 0], [0.9, 0.15], [0, 1]])),
        new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 0.9, 0.6, 0.2), 0]])),
      ],
      material: this.soft, renderMode: RenderMode.BillBoard, renderOrder: 3,
    });
    const embers = new ParticleSystem({
      duration: 2, looping: true, worldSpace: false, prewarm: true,
      startLife: new IntervalValue(1.1, 2.2), startSpeed: new IntervalValue(15 * k, 45 * k), startSize: new IntervalValue(2 * k, 3.6 * k),
      startColor: new ConstantColor(new QVector4(1, 0.78, 0.4, 1)), emissionOverTime: new ConstantValue(16 * density),
      shape: new MeshSurfaceEmitter(this.seeds(this.tops)),
      behaviors: [
        new ApplyForce(v3(0, 1, 0), new ConstantValue(48 * k)),
        new ColorOverLife(new Gradient([[v3(1, 0.9, 0.6), 0], [v3(1, 0.45, 0.1), 0.6], [v3(0.6, 0.12, 0.02), 1]], [[0, 0], [1, 0.1], [0.8, 0.7], [0, 1]])),
      ],
      material: this.soft, renderMode: RenderMode.BillBoard, renderOrder: 3,
    });
    for (const s of [flames, core, embers]) { this.batch.addSystem(s); this.scene.add(s.emitter); this.systems.push(s); }
  }

  /** Tiny upright triangles at the given points: a surface for MeshSurfaceEmitter to scatter births over. Standing in
   *  the XZ plane, their normal is +Y, so each particle launches upward along it. */
  private seeds(points: P[]): THREE.BufferGeometry {
    const pos: number[] = [], idx: number[] = [];
    points.forEach((p, i) => {
      pos.push(p.x - 1.2, p.y, 0, p.x + 1.2, p.y, 0, p.x, p.y, -1.2);
      idx.push(i * 3, i * 3 + 1, i * 3 + 2);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  // ------------------------------------------------------------------------------------------------ lightning
  private strike(): void {
    const pick = (list: P[]) => list[Math.floor(Math.random() * list.length)];
    const tw = this.upper.length ? Math.abs(this.upper[this.upper.length - 1].x - this.upper[0].x) : this.w;
    let a: P, b: P, bow: P | null;
    if (Math.random() < 0.6 && this.upper.length > 4) {
      // an arc leaping between two letters
      a = pick(this.upper);
      do b = pick(this.upper); while (Math.abs(b.x - a.x) < tw * 0.15 && Math.random() < 0.95);
      bow = { x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) + rand(0.12, 0.35) * this.h };
    } else {
      // a strike from the sky onto a letter
      b = pick(this.upper.length ? this.upper : this.tops);
      a = { x: b.x + rand(-0.25, 0.25) * tw, y: this.h + 4 };
      bow = null;
    }
    this.bolt?.mesh.geometry.dispose();
    if (this.bolt) this.scene.remove(this.bolt.mesh);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.boltMat.clone());
    mesh.renderOrder = 4;
    this.scene.add(mesh);
    this.bolt = { mesh, a, b, bow, age: 0, life: rand(0.28, 0.45), flick: 0, branches: Math.random() < 0.7 ? Math.ceil(rand(0, 2)) : 0 };
    this.reshape();
    // where it lands: a flash, sparks, and the title lights up
    this.flash.position.set(b.x, b.y, 0);
    this.flash.scale.setScalar(90 * this.scale);
    this.flashAge = 0;
    this.burst(b);
    this.host.classList.remove('zap'); void this.host.offsetWidth; this.host.classList.add('zap');
  }

  private reshape(): void {
    const bo = this.bolt!;
    const main = boltPath(bo.a, bo.b, bo.bow, 5, 0.1);
    const paths = [{ pts: main, width: 11 * this.scale }];
    for (let i = 0; i < bo.branches; i++) {
      const j = Math.floor(rand(0.2, 0.7) * main.length), p = main[j], q = main[Math.min(main.length - 1, j + 4)];
      const ang = Math.atan2(q.y - p.y, q.x - p.x) + rand(-0.9, 0.9), len = rand(0.15, 0.3) * Math.hypot(bo.b.x - bo.a.x, bo.b.y - bo.a.y);
      paths.push({ pts: boltPath(p, { x: p.x + Math.cos(ang) * len, y: p.y + Math.sin(ang) * len }, null, 4, 0.15), width: 6 * this.scale });
    }
    bo.mesh.geometry.dispose();
    bo.mesh.geometry = ribbons(paths);
  }

  private burst(at: P): void {
    if (this.sparks) { this.batch.deleteSystem(this.sparks); this.scene.remove(this.sparks.emitter); }
    const k = this.scale;
    const s = new ParticleSystem({
      duration: 0.6, looping: false, autoDestroy: true, worldSpace: false,
      startLife: new IntervalValue(0.25, 0.55), startSpeed: new IntervalValue(60 * k, 170 * k), startSize: new IntervalValue(2 * k, 4.5 * k),
      startColor: new ConstantColor(new QVector4(0.85, 0.93, 1, 1)), emissionOverTime: new ConstantValue(0),
      emissionBursts: [{ time: 0, count: new ConstantValue(coarse ? 14 : 22), cycle: 1, interval: 0.01, probability: 1 }],
      shape: new PointEmitter(),
      behaviors: [
        new ApplyForce(v3(0, -1, 0), new ConstantValue(260 * k)),
        new ColorOverLife(new Gradient([[v3(1, 1, 1), 0], [v3(0.55, 0.75, 1), 0.5], [v3(0.3, 0.4, 1), 1]], [[1, 0], [1, 0.4], [0, 1]])),
      ],
      material: this.soft, renderMode: RenderMode.BillBoard, renderOrder: 5,
    });
    s.emitter.position.set(at.x, at.y, 0);
    this.batch.addSystem(s);
    this.scene.add(s.emitter);
    this.sparks = s;
  }

  private tick(): void {
    const now = performance.now(), dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    if (this.clock >= this.nextStrike && this.upper.length) {
      this.strike();
      this.nextStrike = this.clock + rand(1.6, 3.8);
    }
    const bo = this.bolt;
    if (bo) {
      bo.age += dt;
      bo.flick += dt;
      if (bo.flick > 0.075 && bo.age < bo.life * 0.8) { bo.flick = 0; this.reshape(); }
      const k = bo.age / bo.life;
      (bo.mesh.material as THREE.MeshBasicMaterial).opacity = k >= 1 ? 0 : (1 - k) * (0.65 + 0.35 * Math.abs(Math.sin(bo.age * 70)));
      if (k >= 1) { this.scene.remove(bo.mesh); bo.mesh.geometry.dispose(); (bo.mesh.material as THREE.Material).dispose(); this.bolt = null; }
    }
    this.flashAge += dt;
    this.flash.visible = this.flashAge < 0.3;
    if (this.flash.visible) (this.flash.material as THREE.MeshBasicMaterial).opacity = 1 - this.flashAge / 0.3;
    this.batch.update(dt);
    this.renderer!.render(this.scene, this.camera);
  }
}
