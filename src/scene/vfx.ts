/**
 * Particle effects on three.quarks. Sprite systems for light (bursts, sparks, embers) and mesh systems for
 * matter: obsidian and gold shards fly when a champion falls, a trail of the element follows every move,
 * a ring of runes rises for check, and the finish is a crown of fire. One shared BatchedRenderer draws them all.
 */
import * as THREE from 'three';
import {
  BatchedRenderer, ParticleSystem, RenderMode, ConstantValue, IntervalValue, ConstantColor, ColorOverLife, Gradient, SizeOverLife,
  PiecewiseBezier, Bezier, SphereEmitter, ConeEmitter, PointEmitter, ApplyForce, GravityForce, RotationOverLife, Vector3 as QVector3, Vector4 as QVector4,
} from 'three.quarks';
import { softParticleTexture } from './assets';
import { tweens, ease } from './tween';

const v4 = (c: THREE.Color, a = 1) => new QVector4(c.r, c.g, c.b, a);
const v3 = (c: THREE.Color) => new QVector3(c.r, c.g, c.b);
const up = (y: number) => new QVector3(0, y, 0);
const fadeOut = () => new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 0.9, 0.6, 0), 0]]));
const bright = (c: THREE.Color, k = 0.4) => c.clone().lerp(new THREE.Color(0xffffff), k);

export class VFX {
  private readonly batch = new BatchedRenderer();
  private readonly sprite: THREE.MeshBasicMaterial;
  private readonly shardDark: THREE.MeshStandardMaterial;
  private readonly shardGold: THREE.MeshStandardMaterial;
  private readonly shardGeo = new THREE.TetrahedronGeometry(0.09, 0);
  private readonly runeGeo = new THREE.PlaneGeometry(0.16, 0.16);
  private embersSystem: ParticleSystem | null = null;
  /** Mesh particles are the expensive ones: 'low' quality keeps only the sprites. */
  rich = true;

  constructor(private readonly scene: THREE.Scene) {
    scene.add(this.batch);
    this.sprite = new THREE.MeshBasicMaterial({ map: softParticleTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.shardDark = new THREE.MeshStandardMaterial({ color: 0x0b070e, roughness: 0.25, metalness: 0.5, emissive: 0x000000 });
    this.shardGold = new THREE.MeshStandardMaterial({ color: 0xffbf5e, roughness: 0.3, metalness: 1 });
    this.embers(new THREE.Color(0xffb070));
  }

  update(dt: number): void { this.batch.update(dt); }

  private spawn(ps: ParticleSystem, at: THREE.Vector3): ParticleSystem {
    ps.emitter.position.copy(at);
    this.batch.addSystem(ps);
    this.scene.add(ps.emitter);
    return ps;
  }
  private remove(ps: ParticleSystem): void {
    this.scene.remove(ps.emitter);
    this.batch.deleteSystem(ps);
  }

  /** Drifting embers over the whole board, in the realm's colour. */
  embers(color: THREE.Color): void {
    if (this.embersSystem) this.remove(this.embersSystem);
    const ps = new ParticleSystem({
      duration: 6, looping: true, prewarm: true, worldSpace: true,
      startLife: new IntervalValue(5, 9), startSpeed: new IntervalValue(0.03, 0.12), startSize: new IntervalValue(0.025, 0.07),
      startColor: new ConstantColor(v4(color, 0.9)), emissionOverTime: new ConstantValue(10),
      shape: new SphereEmitter({ radius: 6.5, thickness: 1, arc: Math.PI * 2 }),
      behaviors: [
        new ApplyForce(up(1), new ConstantValue(0.025)),
        new ColorOverLife(new Gradient([[v3(color), 0], [v3(color.clone().multiplyScalar(0.7)), 0.6], [v3(new THREE.Color(0x100400)), 1]], [[0, 0], [1, 0.15], [1, 0.7], [0, 1]])),
      ],
      material: this.sprite, renderMode: RenderMode.BillBoard, renderOrder: 3,
    });
    this.embersSystem = this.spawn(ps, new THREE.Vector3(0, 1.2, 0));
  }

  /** A champion falls: sparks in their element, obsidian or gold shards thrown up, a flash and a shockwave. */
  burst(at: THREE.Vector3, color: THREE.Color, gold = false): void {
    const hot = bright(color, 0.35);
    const sparks = new ParticleSystem({
      duration: 1.2, looping: false, autoDestroy: true, worldSpace: true,
      startLife: new IntervalValue(0.5, 1.2), startSpeed: new IntervalValue(1.2, 4.2), startSize: new IntervalValue(0.06, 0.2),
      startColor: new ConstantColor(v4(hot)), emissionOverTime: new ConstantValue(0),
      emissionBursts: [{ time: 0, count: new ConstantValue(90), cycle: 1, interval: 0.01, probability: 1 }],
      shape: new ConeEmitter({ radius: 0.15, angle: Math.PI / 3, thickness: 1, arc: Math.PI * 2 }),
      behaviors: [new GravityForce(up(-1), 2.5), fadeOut(),
        new ColorOverLife(new Gradient([[v3(hot), 0], [v3(color), 0.4], [v3(color.clone().multiplyScalar(0.3)), 1]], [[1, 0], [1, 0.5], [0, 1]]))],
      material: this.sprite, renderMode: RenderMode.BillBoard, renderOrder: 4,
    });
    sparks.emitter.rotation.x = -Math.PI / 2;
    this.spawn(sparks, at.clone().add(new THREE.Vector3(0, 0.4, 0)));
    if (this.rich) {
      const shards = new ParticleSystem({
        duration: 1.5, looping: false, autoDestroy: true, worldSpace: true,
        startLife: new IntervalValue(0.9, 1.6), startSpeed: new IntervalValue(1.5, 4.5), startSize: new IntervalValue(0.5, 1.4),
        startColor: new ConstantColor(new QVector4(1, 1, 1, 1)), emissionOverTime: new ConstantValue(0),
        emissionBursts: [{ time: 0, count: new ConstantValue(26), cycle: 1, interval: 0.01, probability: 1 }],
        shape: new ConeEmitter({ radius: 0.2, angle: Math.PI / 2.6, thickness: 1, arc: Math.PI * 2 }),
        behaviors: [new GravityForce(up(-1), 6), new RotationOverLife(new IntervalValue(-8, 8)), fadeOut()],
        material: gold ? this.shardGold : this.shardDark, instancingGeometry: this.shardGeo, renderMode: RenderMode.Mesh, renderOrder: 1,
      });
      shards.emitter.rotation.x = -Math.PI / 2;
      this.spawn(shards, at.clone().add(new THREE.Vector3(0, 0.3, 0)));
    }
    this.flash(at, color, 1.6, 0.5);
    this.shock(at, color);
  }

  /** The element streams behind a moving champion: call per frame with the piece's position while it travels. */
  trail(color: THREE.Color): { emitter: THREE.Object3D; stop(): void } {
    const ps = new ParticleSystem({
      duration: 2, looping: true, worldSpace: true,
      startLife: new IntervalValue(0.35, 0.7), startSpeed: new IntervalValue(0.05, 0.3), startSize: new IntervalValue(0.05, 0.14),
      startColor: new ConstantColor(v4(bright(color, 0.3))), emissionOverTime: new ConstantValue(this.rich ? 90 : 45),
      shape: new SphereEmitter({ radius: 0.12, thickness: 1, arc: Math.PI * 2 }),
      behaviors: [new ApplyForce(up(1), new ConstantValue(0.4)), fadeOut(),
        new ColorOverLife(new Gradient([[v3(bright(color, 0.3)), 0], [v3(color), 0.5], [v3(color.clone().multiplyScalar(0.2)), 1]], [[0.9, 0], [0.6, 0.6], [0, 1]]))],
      material: this.sprite, renderMode: RenderMode.BillBoard, renderOrder: 4,
    });
    this.spawn(ps, new THREE.Vector3());
    return {
      emitter: ps.emitter,
      stop: () => { ps.emissionOverTime = new ConstantValue(0); setTimeout(() => this.remove(ps), 900); },
    };
  }

  /** A piece lands: a soft ring of light and a few sparks. */
  landing(at: THREE.Vector3, color: THREE.Color): void {
    this.flash(at, color, 0.7, 0.35);
    const ps = new ParticleSystem({
      duration: 0.5, looping: false, autoDestroy: true, worldSpace: true,
      startLife: new IntervalValue(0.3, 0.6), startSpeed: new IntervalValue(0.6, 1.6), startSize: new IntervalValue(0.03, 0.08),
      startColor: new ConstantColor(v4(bright(color, 0.5))), emissionOverTime: new ConstantValue(0),
      emissionBursts: [{ time: 0, count: new ConstantValue(26), cycle: 1, interval: 0.01, probability: 1 }],
      shape: new ConeEmitter({ radius: 0.3, angle: Math.PI / 2.2, thickness: 1, arc: Math.PI * 2 }),
      behaviors: [new GravityForce(up(-1), 1.2), fadeOut()],
      material: this.sprite, renderMode: RenderMode.BillBoard, renderOrder: 4,
    });
    ps.emitter.rotation.x = -Math.PI / 2;
    this.spawn(ps, at.clone().add(new THREE.Vector3(0, 0.05, 0)));
  }

  /** Check: a ring of glowing runes rises around the threatened king. */
  check(at: THREE.Vector3, color = new THREE.Color(0xff4040)): void {
    const ps = new ParticleSystem({
      duration: 1.2, looping: false, autoDestroy: true, worldSpace: true,
      startLife: new IntervalValue(1.0, 1.4), startSpeed: new ConstantValue(0), startSize: new IntervalValue(0.9, 1.4),
      startColor: new ConstantColor(v4(bright(color, 0.3), 1)), emissionOverTime: new ConstantValue(0),
      emissionBursts: [{ time: 0, count: new ConstantValue(this.rich ? 24 : 12), cycle: 1, interval: 0.01, probability: 1 }],
      shape: new SphereEmitter({ radius: 0.62, thickness: 0.02, arc: Math.PI * 2 }),
      behaviors: [new ApplyForce(up(1), new ConstantValue(1.2)), new RotationOverLife(new IntervalValue(-2, 2)),
        new SizeOverLife(new PiecewiseBezier([[new Bezier(0.2, 1, 1, 0), 0]]))],
      material: this.sprite, instancingGeometry: this.runeGeo, renderMode: this.rich ? RenderMode.Mesh : RenderMode.BillBoard, renderOrder: 4,
    });
    this.spawn(ps, at.clone().add(new THREE.Vector3(0, 0.15, 0)));
    this.flash(at, color, 1.2, 0.8);
  }

  /** A pawn ascends: a column of light climbing from the square, with a crown of gold shards. */
  ascension(at: THREE.Vector3, color: THREE.Color): void {
    const ps = new ParticleSystem({
      duration: 1.4, looping: false, autoDestroy: true, worldSpace: true,
      startLife: new IntervalValue(0.8, 1.4), startSpeed: new IntervalValue(1.5, 3), startSize: new IntervalValue(0.05, 0.14),
      startColor: new ConstantColor(v4(bright(color, 0.5))), emissionOverTime: new ConstantValue(140),
      shape: new SphereEmitter({ radius: 0.28, thickness: 1, arc: Math.PI * 2 }),
      behaviors: [new ApplyForce(up(1), new ConstantValue(3)), fadeOut()],
      material: this.sprite, renderMode: RenderMode.BillBoard, renderOrder: 4,
    });
    this.spawn(ps, at.clone());
    if (this.rich) {
      const crown = new ParticleSystem({
        duration: 1, looping: false, autoDestroy: true, worldSpace: true,
        startLife: new IntervalValue(1.2, 1.8), startSpeed: new IntervalValue(0.8, 1.6), startSize: new IntervalValue(0.5, 1.0),
        startColor: new ConstantColor(new QVector4(1, 1, 1, 1)), emissionOverTime: new ConstantValue(0),
        emissionBursts: [{ time: 0.3, count: new ConstantValue(18), cycle: 1, interval: 0.01, probability: 1 }],
        shape: new ConeEmitter({ radius: 0.05, angle: Math.PI / 5, thickness: 1, arc: Math.PI * 2 }),
        behaviors: [new GravityForce(up(-1), 1.5), new RotationOverLife(new IntervalValue(-6, 6)), fadeOut()],
        material: this.shardGold, instancingGeometry: this.shardGeo, renderMode: RenderMode.Mesh, renderOrder: 1,
      });
      crown.emitter.rotation.x = -Math.PI / 2;
      this.spawn(crown, at.clone().add(new THREE.Vector3(0, 0.9, 0)));
    }
    this.flash(at, color, 2.2, 1.2);
  }

  /** The end: a tall crown of fire over the winner's king and a slow rain of gold. */
  finale(at: THREE.Vector3, color: THREE.Color): void {
    const fire = new ParticleSystem({
      duration: 3, looping: false, autoDestroy: true, worldSpace: true,
      startLife: new IntervalValue(1.0, 2.2), startSpeed: new IntervalValue(2, 5), startSize: new IntervalValue(0.08, 0.3),
      startColor: new ConstantColor(v4(bright(color, 0.4))), emissionOverTime: new ConstantValue(160),
      shape: new ConeEmitter({ radius: 0.3, angle: Math.PI / 7, thickness: 1, arc: Math.PI * 2 }),
      behaviors: [new GravityForce(up(-1), 1.0), fadeOut(),
        new ColorOverLife(new Gradient([[v3(bright(color, 0.6)), 0], [v3(color), 0.5], [v3(new THREE.Color(0x200800)), 1]], [[1, 0], [0.8, 0.6], [0, 1]]))],
      material: this.sprite, renderMode: RenderMode.BillBoard, renderOrder: 4,
    });
    fire.emitter.rotation.x = -Math.PI / 2;
    this.spawn(fire, at.clone().add(new THREE.Vector3(0, 0.3, 0)));
    if (this.rich) {
      const rain = new ParticleSystem({
        duration: 3, looping: false, autoDestroy: true, worldSpace: true,
        startLife: new IntervalValue(2, 3.5), startSpeed: new IntervalValue(0, 0.3), startSize: new IntervalValue(0.4, 0.9),
        startColor: new ConstantColor(new QVector4(1, 1, 1, 1)), emissionOverTime: new ConstantValue(30),
        shape: new SphereEmitter({ radius: 3.5, thickness: 1, arc: Math.PI * 2 }),
        behaviors: [new GravityForce(up(-1), 0.6), new RotationOverLife(new IntervalValue(-4, 4)), fadeOut()],
        material: this.shardGold, instancingGeometry: this.shardGeo, renderMode: RenderMode.Mesh, renderOrder: 1,
      });
      this.spawn(rain, at.clone().add(new THREE.Vector3(0, 5, 0)));
    }
    this.flash(at, color, 3, 2.5);
    this.shock(at, color);
  }

  /** A quick sparkle at a selected piece. */
  select(at: THREE.Vector3, color: THREE.Color): void {
    const ps = new ParticleSystem({
      duration: 0.3, looping: false, autoDestroy: true, worldSpace: true,
      startLife: new IntervalValue(0.4, 0.8), startSpeed: new IntervalValue(0.2, 0.6), startSize: new IntervalValue(0.02, 0.06),
      startColor: new ConstantColor(v4(bright(color, 0.6))), emissionOverTime: new ConstantValue(0),
      emissionBursts: [{ time: 0, count: new ConstantValue(18), cycle: 1, interval: 0.01, probability: 1 }],
      shape: new PointEmitter(),
      behaviors: [new ApplyForce(up(1), new ConstantValue(0.6)), fadeOut()],
      material: this.sprite, renderMode: RenderMode.BillBoard, renderOrder: 4,
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
