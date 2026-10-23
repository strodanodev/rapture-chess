/**
 * The main-menu title as real geometry: RAPTURE / CHESS in bevelled Cinzel (scripts/build-logo.py), gilded, with a
 * band of light sweeping across it, glints sparking on the letter faces and embers lifting off them.
 *
 * It lives in its own small scene drawn as an overlay pass right after the arena (Stage.overlay), so no pillar
 * can ever cut through it and it still goes through bloom and tone mapping with everything else. The group rides
 * the camera; `place()` fits it over a DOM element (the logo slot of the menu), so the CSS layout decides where it
 * sits on every screen size.
 */
import * as THREE from 'three';
import {
  BatchedRenderer, ParticleSystem, RenderMode, ConstantValue, IntervalValue, ConstantColor, ColorOverLife, Gradient, SizeOverLife,
  PiecewiseBezier, Bezier, ApplyForce, MeshSurfaceEmitter, Vector3 as QVector3, Vector4 as QVector4,
} from 'three.quarks';
import { loadModel, softParticleTexture } from './assets';

const DEPTH = 7;          // metres in front of the camera
const WIDTH = 5.57;       // RAPTURE's width in the model
const TOP = 1.02, BOTTOM = -0.98;

/** A four-point star for the glints. */
function starTexture(): THREE.Texture {
  const s = 64, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.15, 'rgba(255,240,200,0.8)'); grad.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = grad;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2, r = i % 2 ? s * 0.07 : s / 2;
    g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r);
  }
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Title3D {
  readonly scene = new THREE.Scene();
  readonly group = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly batch = new BatchedRenderer();
  private readonly sweep = { value: -2 };
  /** World -> title space, so the sweep crosses the words left to right whatever the camera does. */
  private readonly inv = { value: new THREE.Matrix4() };
  private readonly offset = new THREE.Vector3(0, 0, -DEPTH);
  private scale = 1;
  private ready = false;
  shown = false;

  constructor(environment: THREE.Texture | null) {
    this.scene.environment = environment;
    this.scene.environmentIntensity = 1.0;
    const key = new THREE.DirectionalLight(0xffe6c0, 3.8);
    key.position.set(-3, 4, 6);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 1.4);
    rim.position.set(4, 2, -3);
    this.scene.add(key, rim, new THREE.AmbientLight(0x40301c, 0.6), this.group, this.batch);
    this.group.add(this.pivot);
    this.group.visible = false;
  }

  async load(): Promise<void> {
    const gltf = await loadModel('title.glb');
    const gold = new THREE.MeshPhysicalMaterial({ color: 0xeaa53c, metalness: 1, roughness: 0.3, clearcoat: 0.4, clearcoatRoughness: 0.18, envMapIntensity: 2.3, emissive: 0x140900, fog: false });
    gold.onBeforeCompile = (sh) => {
      sh.uniforms.uSweep = this.sweep;
      sh.uniforms.uInv = this.inv;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform mat4 uInv;\nvarying vec3 vTitle;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTitle = (uInv * modelMatrix * vec4(position, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uSweep;\nvarying vec3 vTitle;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  { float d = (vTitle.x + vTitle.y * 0.6) / 3.2 - uSweep; totalEmissiveRadiance += vec3(1.0, 0.72, 0.32) * smoothstep(0.1, 0.0, abs(d)) * 0.9; }');
    };
    const geos: Array<{ geo: THREE.BufferGeometry; main: boolean }> = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.material = gold;
      o.renderOrder = 2;
      // the emitters need the letters in title space (x right, y up), not in the node's own space
      geos.push({ geo: (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld), main: /rapture/i.test(o.name) });
    });
    // centre the block (both words) on the group origin
    gltf.scene.position.y = -(TOP + BOTTOM) / 2;
    this.pivot.add(gltf.scene);
    this.particles(geos, -(TOP + BOTTOM) / 2);
    this.ready = true;
  }

  private particles(geos: Array<{ geo: THREE.BufferGeometry; main: boolean }>, dy: number): void {
    const star = new THREE.MeshBasicMaterial({ map: starTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false });
    const soft = new THREE.MeshBasicMaterial({ map: softParticleTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    const warm = new THREE.Color(0xffd27a), hot = new THREE.Color(0xfff4d8), ember = new THREE.Color(0xff8a2a);
    const v4 = (c: THREE.Color, a = 1) => new QVector4(c.r, c.g, c.b, a);
    const v3 = (c: THREE.Color) => new QVector3(c.r, c.g, c.b);
    for (const { geo, main } of geos) {
      const big = main ? 1 : 0.5; // RAPTURE gets most of the light
      // glints: brief four-point stars flaring on the letter faces
      const glints = new ParticleSystem({
        duration: 1, looping: true, worldSpace: false,
        startLife: new IntervalValue(0.3, 0.6), startSpeed: new ConstantValue(0), startSize: new IntervalValue(0.12, 0.26),
        startRotation: new IntervalValue(0, Math.PI / 4), startColor: new ConstantColor(v4(hot)), emissionOverTime: new ConstantValue(2.5 * big),
        shape: new MeshSurfaceEmitter(geo),
        behaviors: [new SizeOverLife(new PiecewiseBezier([[new Bezier(0, 1, 1, 0), 0]]))],
        material: star, renderMode: RenderMode.BillBoard, renderOrder: 5,
      });
      // embers: gold sparks lifting off the letters and cooling to orange
      const sparks = new ParticleSystem({
        duration: 2, looping: true, worldSpace: false, prewarm: true,
        startLife: new IntervalValue(1.4, 2.6), startSpeed: new IntervalValue(0.05, 0.2), startSize: new IntervalValue(0.025, 0.055),
        startColor: new ConstantColor(v4(warm)), emissionOverTime: new ConstantValue(12 * big),
        shape: new MeshSurfaceEmitter(geo),
        behaviors: [
          new ApplyForce(new QVector3(0, 1, 0), new ConstantValue(0.35)),
          new ColorOverLife(new Gradient([[v3(hot), 0], [v3(warm), 0.3], [v3(ember), 1]], [[0, 0], [1, 0.1], [1, 0.6], [0, 1]])),
          new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 0.9, 0.5, 0), 0]])),
        ],
        material: soft, renderMode: RenderMode.BillBoard, renderOrder: 4,
      });
      for (const ps of [glints, sparks]) {
        ps.emitter.position.y = dy;
        this.pivot.add(ps.emitter);
        this.batch.addSystem(ps);
      }
    }
  }

  /** Fit the title over a screen rectangle (CSS pixels), as seen by `camera`. */
  place(rect: DOMRect | null, camera: THREE.PerspectiveCamera, viewport: { width: number; height: number }): void {
    if (!rect || !rect.width) { this.shown = false; this.group.visible = false; return; }
    const h = 2 * DEPTH * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const perPx = h / viewport.height;
    // a view offset (the menu slides the picture sideways) moves the projection centre: undo it here
    const off = camera.view?.enabled ? camera.view.offsetX : 0;
    const cx = rect.left + rect.width / 2 + off - viewport.width / 2, cy = viewport.height / 2 - (rect.top + rect.height / 2);
    this.scale = Math.min((rect.width * perPx) / WIDTH, (rect.height * perPx) / (TOP - BOTTOM));
    this.offset.set(cx * perPx, cy * perPx, -DEPTH);
    this.group.scale.setScalar(this.scale);
  }

  show(on: boolean): void { this.shown = on; }

  update(dt: number, t: number, camera: THREE.Camera): void {
    this.group.visible = this.ready && this.shown;
    if (!this.group.visible) return;
    // ride the camera
    this.group.quaternion.copy(camera.quaternion);
    this.group.position.copy(this.offset).applyQuaternion(camera.quaternion).add(camera.position);
    // a slow sway so the bevels catch the light, and the sweep crossing every few seconds
    this.pivot.rotation.set(Math.sin(t * 0.35) * 0.06, Math.sin(t * 0.27) * 0.12, 0);
    this.group.updateMatrixWorld(true);
    this.inv.value.copy(this.pivot.matrixWorld).invert();
    const cycle = (t % 5.5) / 5.5;
    this.sweep.value = -1.6 + cycle * 4.2;
    this.batch.update(dt);
  }
}
