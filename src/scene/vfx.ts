/**
 * Particle effects on three.quarks: capture bursts in the fallen champion's element, a landing pulse when a
 * piece arrives, an ascension column for promotions, and the embers that drift over the board all game.
 */
import * as THREE from 'three';
import {
  BatchedRenderer, ParticleSystem, RenderMode, ConstantValue, IntervalValue, ConstantColor, ColorOverLife, Gradient, SizeOverLife,
  PiecewiseBezier, Bezier, SphereEmitter, ConeEmitter, PointEmitter, ApplyForce, GravityForce, Vector3 as QVector3, Vector4 as QVector4,
} from 'three.quarks';
import { softParticleTexture } from './assets';
import { tweens, ease } from './tween';

const v4 = (c: THREE.Color, a = 1) => new QVector4(c.r, c.g, c.b, a);
const v3 = (c: THREE.Color) => new QVector3(c.r, c.g, c.b);
const up = (y: number) => new QVector3(0, y, 0);
const fadeOut = () => new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 0.9, 0.6, 0), 0]]));

export class VFX {
  private readonly batch = new BatchedRenderer();
  private readonly material: THREE.MeshBasicMaterial;

  constructor(private readonly scene: THREE.Scene) {
    scene.add(this.batch);
    this.material = new THREE.MeshBasicMaterial({ map: softParticleTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.embers();
  }

  update(dt: number): void { this.batch.update(dt); }

  private spawn(ps: ParticleSystem, at: THREE.Vector3): void {
    ps.emitter.position.copy(at);
    this.batch.addSystem(ps);
    this.scene.add(ps.emitter);
  }

  /** Drifting embers over the whole board: a slow, looping system. */
  private embers(): void {
    const warm = new THREE.Color(0xffb070);
    const ps = new ParticleSystem({
      duration: 6, looping: true, prewarm: true, worldSpace: true,
      startLife: new IntervalValue(5, 9), startSpeed: new IntervalValue(0.03, 0.12), startSize: new IntervalValue(0.025, 0.07),
      startColor: new ConstantColor(v4(warm, 0.9)), emissionOverTime: new ConstantValue(10),
      shape: new SphereEmitter({ radius: 6.5, thickness: 1, arc: Math.PI * 2 }),
      behaviors: [
        new ApplyForce(up(1), new ConstantValue(0.025)),
        new ColorOverLife(new Gradient([[v3(warm), 0], [v3(new THREE.Color(0xff6a2a)), 0.6], [v3(new THREE.Color(0x200800)), 1]], [[0, 0], [1, 0.15], [1, 0.7], [0, 1]])),
      ],
      material: this.material, renderMode: RenderMode.BillBoard, renderOrder: 3,
    });
    this.spawn(ps, new THREE.Vector3(0, 1.2, 0));
  }

  /** A champion falls: a burst in their element, sparks thrown up, and a short flash. */
  burst(at: THREE.Vector3, color: THREE.Color): void {
    const bright = color.clone().lerp(new THREE.Color(0xffffff), 0.35);
    const ps = new ParticleSystem({
      duration: 1.2, looping: false, autoDestroy: true, worldSpace: true,
      startLife: new IntervalValue(0.5, 1.2), startSpeed: new IntervalValue(1.2, 4.2), startSize: new IntervalValue(0.06, 0.2),
      startColor: new ConstantColor(v4(bright)), emissionOverTime: new ConstantValue(0),
      emissionBursts: [{ time: 0, count: new ConstantValue(90), cycle: 1, interval: 0.01, probability: 1 }],
      shape: new ConeEmitter({ radius: 0.15, angle: Math.PI / 3, thickness: 1, arc: Math.PI * 2 }),
      behaviors: [new GravityForce(up(-1), 2.5), fadeOut(),
        new ColorOverLife(new Gradient([[v3(bright), 0], [v3(color), 0.4], [v3(color.clone().multiplyScalar(0.3)), 1]], [[1, 0], [1, 0.5], [0, 1]]))],
      material: this.material, renderMode: RenderMode.BillBoard, renderOrder: 4,
    });
    ps.emitter.rotation.x = -Math.PI / 2; // cone up
    this.spawn(ps, at.clone().add(new THREE.Vector3(0, 0.4, 0)));
    this.flash(at, color, 1.6, 0.5);
    this.shock(at, color);
  }

  /** A piece lands: a soft ring of light that fades. */
  landing(at: THREE.Vector3, color: THREE.Color): void {
    this.flash(at, color, 0.7, 0.35);
    const ps = new ParticleSystem({
      duration: 0.5, looping: false, autoDestroy: true, worldSpace: true,
      startLife: new IntervalValue(0.3, 0.6), startSpeed: new IntervalValue(0.6, 1.6), startSize: new IntervalValue(0.03, 0.08),
      startColor: new ConstantColor(v4(color.clone().lerp(new THREE.Color(0xffffff), 0.5))), emissionOverTime: new ConstantValue(0),
      emissionBursts: [{ time: 0, count: new ConstantValue(26), cycle: 1, interval: 0.01, probability: 1 }],
      shape: new ConeEmitter({ radius: 0.3, angle: Math.PI / 2.2, thickness: 1, arc: Math.PI * 2 }),
      behaviors: [new GravityForce(up(-1), 1.2), fadeOut()],
      material: this.material, renderMode: RenderMode.BillBoard, renderOrder: 4,
    });
    ps.emitter.rotation.x = -Math.PI / 2;
    this.spawn(ps, at.clone().add(new THREE.Vector3(0, 0.05, 0)));
  }

  /** A pawn ascends: a column of light climbing from the square. */
  ascension(at: THREE.Vector3, color: THREE.Color): void {
    const ps = new ParticleSystem({
      duration: 1.4, looping: false, autoDestroy: true, worldSpace: true,
      startLife: new IntervalValue(0.8, 1.4), startSpeed: new IntervalValue(1.5, 3), startSize: new IntervalValue(0.05, 0.14),
      startColor: new ConstantColor(v4(color.clone().lerp(new THREE.Color(0xffffff), 0.5))), emissionOverTime: new ConstantValue(140),
      shape: new SphereEmitter({ radius: 0.28, thickness: 1, arc: Math.PI * 2 }),
      behaviors: [new ApplyForce(up(1), new ConstantValue(3)), fadeOut()],
      material: this.material, renderMode: RenderMode.BillBoard, renderOrder: 4,
    });
    this.spawn(ps, at.clone());
    this.flash(at, color, 2.2, 1.2);
  }

  /** A quick sparkle at a selected piece. */
  select(at: THREE.Vector3, color: THREE.Color): void {
    const ps = new ParticleSystem({
      duration: 0.3, looping: false, autoDestroy: true, worldSpace: true,
      startLife: new IntervalValue(0.4, 0.8), startSpeed: new IntervalValue(0.2, 0.6), startSize: new IntervalValue(0.02, 0.06),
      startColor: new ConstantColor(v4(color.clone().lerp(new THREE.Color(0xffffff), 0.6))), emissionOverTime: new ConstantValue(0),
      emissionBursts: [{ time: 0, count: new ConstantValue(18), cycle: 1, interval: 0.01, probability: 1 }],
      shape: new PointEmitter(),
      behaviors: [new ApplyForce(up(1), new ConstantValue(0.6)), fadeOut()],
      material: this.material, renderMode: RenderMode.BillBoard, renderOrder: 4,
    });
    this.spawn(ps, at.clone().add(new THREE.Vector3(0, 0.5, 0)));
  }

  /** A brief point light pulse at a square. */
  private flash(at: THREE.Vector3, color: THREE.Color, intensity: number, seconds: number): void {
    const light = new THREE.PointLight(color, 0, 5, 2);
    light.position.copy(at).y += 0.6;
    this.scene.add(light);
    void tweens.run(seconds, (k) => { light.intensity = intensity * 40 * (1 - k); }, ease.outQuad).then(() => this.scene.remove(light));
  }

  /** An expanding ring on the floor. */
  private shock(at: THREE.Vector3, color: THREE.Color): void {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(at).y += 0.02;
    ring.scale.setScalar(0.1);
    this.scene.add(ring);
    void tweens.run(0.55, (k) => { ring.scale.setScalar(0.1 + k * 1.3); (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k); }, ease.outCubic)
      .then(() => { this.scene.remove(ring); ring.geometry.dispose(); });
  }
}
