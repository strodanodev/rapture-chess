/**
 * The stage: renderer, camera, post-processing chain (N8AO ambient occlusion, godrays, bloom, chromatic aberration,
 * vignette, AgX, SMAA), environment lighting, the sky dome, the atmosphere (light shafts, ground mist) and the orbit
 * camera with board-friendly limits.
 *
 * Quality is a preset (ultra/high/medium/low) chosen by the device and then governed by the frame rate: the
 * adaptive controller steps down whenever the average dips under 58 fps and climbs back once it holds over 75.
 * Everything costly is a switch: pixel ratio, AO, godrays resolution and steps, the mirror floor, shadow map size, SMAA and bloom radius.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import {
  Effect, BloomEffect, ChromaticAberrationEffect, HueSaturationEffect, NoiseEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset, VignetteEffect, BlendFunction, KernelSize, ToneMappingEffect, ToneMappingMode,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { GodraysPass, GodraysUpsampleQuality } from 'three-good-godrays';
import { Atmosphere } from './atmosphere';
import { installHeightFog } from './heightfog';
import { tweens } from './tween';

// before any material compiles: the fog chunks gain a height term (thick on the floor, thin in the air)
installHeightFog();

export type Quality = 'ultra' | 'high' | 'medium' | 'low' | 'lite';
export const QUALITIES: Quality[] = ['lite', 'low', 'medium', 'high', 'ultra'];
interface Preset {
  pixelRatio: number; ao: boolean; aoSamples: number; mirror: number; shadow: number; smaa: boolean; bloomKernel: KernelSize; chroma: boolean;
  /** Godrays render-target scale (0 = off) and raymarch steps per pixel. */
  rays: number; raySteps: number;
}
const PRESETS: Record<Quality, Preset> = {
  ultra: { pixelRatio: 2, ao: true, aoSamples: 16, mirror: 1024, shadow: 2048, smaa: true, bloomKernel: KernelSize.LARGE, chroma: true, rays: 0.5, raySteps: 48 },
  high: { pixelRatio: 1.5, ao: true, aoSamples: 8, mirror: 512, shadow: 2048, smaa: true, bloomKernel: KernelSize.MEDIUM, chroma: true, rays: 0.5, raySteps: 32 },
  medium: { pixelRatio: 1.25, ao: false, aoSamples: 8, mirror: 0, shadow: 1024, smaa: true, bloomKernel: KernelSize.MEDIUM, chroma: false, rays: 0.25, raySteps: 20 },
  low: { pixelRatio: 1, ao: false, aoSamples: 8, mirror: 0, shadow: 1024, smaa: false, bloomKernel: KernelSize.SMALL, chroma: false, rays: 0, raySteps: 0 },
  // the floor for weak phone GPUs: three quarters of the CSS resolution and no shadow pass
  lite: { pixelRatio: 0.75, ao: false, aoSamples: 8, mirror: 0, shadow: 0, smaa: false, bloomKernel: KernelSize.VERY_SMALL, chroma: false, rays: 0, raySteps: 0 },
};

export interface RayColors { color: THREE.ColorRepresentation; density: number; maxDensity: number; distanceAttenuation: number }
/** Fire light: warm point lights at the realm's fires (braziers, lava), flickering; how many is a quality setting. */
export interface FireLights { color: THREE.ColorRepresentation; intensity: number; distance: number; positions: Array<[number, number, number]> }
/** The pool: a soft spot from the key light's side that lights the board brighter than the hall (no shadow of its own). */
export interface Pool { color: THREE.ColorRepresentation; intensity: number; angle: number }
/** The realm's colour grade after tone mapping: lift (shadows), gamma (mids) and gain (highlights) per channel. */
export interface Grade { lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number] }
/** The sky's moving parts: a moon (direction, size, colour), a cloud layer, and a glow from below (lava, fire). */
export interface SkyExtras { moon?: { dir: [number, number, number]; color: THREE.ColorRepresentation; size: number }; clouds?: { color: THREE.ColorRepresentation; amount: number; speed: number }; underglow?: number }

/** Fire lights per quality preset: each is a point light every lit fragment pays for, so phones get fewer. */
const FIRES: Record<Quality, number> = { ultra: 4, high: 4, medium: 2, low: 0, lite: 0 };

/** Lift / gamma / gain, merged into the final effect pass (no render target of its own). */
class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', /* glsl */ `
      uniform vec3 lift; uniform vec3 gammaInv; uniform vec3 gain;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = inputColor.rgb * gain + lift * (1.0 - inputColor.rgb);
        outputColor = vec4(pow(max(c, vec3(0.0)), gammaInv), inputColor.a);
      }`, {
      uniforms: new Map<string, THREE.Uniform>([
        ['lift', new THREE.Uniform(new THREE.Vector3())], ['gammaInv', new THREE.Uniform(new THREE.Vector3(1, 1, 1))], ['gain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
      ]),
    });
  }
  set(g: Grade): void {
    (this.uniforms.get('lift')!.value as THREE.Vector3).fromArray(g.lift);
    (this.uniforms.get('gammaInv')!.value as THREE.Vector3).set(1 / g.gamma[0], 1 / g.gamma[1], 1 / g.gamma[2]);
    (this.uniforms.get('gain')!.value as THREE.Vector3).fromArray(g.gain);
  }
}

export const isMobile = (): boolean => matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 820;

export interface SkyColors { top: THREE.ColorRepresentation; bottom: THREE.ColorRepresentation; glow: THREE.ColorRepresentation; fog: THREE.ColorRepresentation; fogDensity: number }

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;
  readonly keyLight: THREE.DirectionalLight;
  readonly rimLight: THREE.SpotLight;
  readonly hemi: THREE.HemisphereLight;
  readonly accentLights: [THREE.PointLight, THREE.PointLight];
  readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  readonly stars: THREE.Points;
  /** Light shafts and ground mist (the cheap volumetrics; the godrays pass is the expensive one). */
  readonly atmosphere: Atmosphere;
  /** Warm flickering lights at the realm's fires (FireLights); FIRES[quality] of them are switched on. */
  private readonly fireLights: THREE.PointLight[] = [];
  private fireBase = 0;
  /** The pool of light on the board: the cinematic contrast between the lit table and the dark hall. */
  private readonly pool: THREE.SpotLight;
  private readonly grade = new GradeEffect();
  quality: Quality = 'high';
  auto = true;
  fps = 60;
  private readonly timer = new THREE.Timer();
  private readonly updaters: Array<(dt: number, t: number) => void> = [];
  private readonly qualityListeners: Array<(q: Quality, fps: number) => void> = [];
  private bloom: BloomEffect;
  private ao: N8AOPostPass | null = null;
  /** Shadow-aware volumetric rays from the key light (three-good-godrays), between AO and bloom. */
  private godrays: GodraysPass | null = null;
  private rays: RayColors = { color: 0xa9c6ff, density: 1 / 70, maxDensity: 0.28, distanceAttenuation: 2 };
  private smaa: SMAAEffect;
  private grain: NoiseEffect;
  /** Set false while assets load: those frames say nothing about the game's frame rate. */
  governing = true;
  /** An opaque menu covers the canvas: skip drawing (the clocks and tweens keep running). */
  paused = false;
  /** Attract mode: the camera circles the board slowly (the main menu). */
  attract = false;
  private attractAngle = 0.6;
  private shakeLeft = 0;
  private shakeAmp = 0;
  private readonly shakeOffset = new THREE.Vector3();
  private chroma: ChromaticAberrationEffect;
  private mirror: Reflector | null = null;
  private frames = 0;
  private sampleTime = 0;
  private lowStreak = 0;
  private highStreak = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // applied as a post effect, see below
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 160);
    this.camera.position.set(0, 9.5, 11.5);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.35, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 6.5;
    this.controls.maxDistance = 20;
    this.controls.minPolarAngle = 0.2;
    this.controls.maxPolarAngle = 1.32;
    this.controls.rotateSpeed = 0.6;

    // environment: a neutral studio for reflections, dim so the lights lead
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    this.scene.fog = new THREE.FogExp2(0x05050a, 0.028);
    this.scene.background = new THREE.Color(0x05050a);

    // lights: warm key with shadows, cool rim, two element-coloured accents the match recolours
    this.keyLight = new THREE.DirectionalLight(0xfff1dc, 2.2);
    this.keyLight.position.set(5, 11, 6);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.bias = -0.00025;
    this.keyLight.shadow.normalBias = 0.02;
    const sc = this.keyLight.shadow.camera;
    // near/far also bound the godrays raymarch slab: start it a few metres above the tallest champion so the rays live
    // round the board instead of veiling the pillars and sky behind it
    sc.left = sc.bottom = -6.5; sc.right = sc.top = 6.5; sc.near = 9; sc.far = 24;
    this.scene.add(this.keyLight, this.keyLight.target);
    this.rimLight = new THREE.SpotLight(0x8fb4ff, 40, 40, Math.PI / 5, 0.6, 1.4);
    this.rimLight.position.set(-6, 8, -9);
    this.scene.add(this.rimLight, this.rimLight.target);
    const a0 = new THREE.PointLight(0x38a8ff, 18, 14, 1.8), a1 = new THREE.PointLight(0xff6a2a, 18, 14, 1.8);
    a0.position.set(-5.5, 1.6, 5.5); a1.position.set(5.5, 1.6, -5.5);
    this.accentLights = [a0, a1];
    this.hemi = new THREE.HemisphereLight(0x2a2f45, 0x080608, 0.5);
    this.scene.add(a0, a1, this.hemi);
    this.pool = new THREE.SpotLight(0xfff0d8, 0, 40, 0.42, 0.85, 1.2);
    this.pool.position.set(5, 16, 6);
    this.scene.add(this.pool, this.pool.target);
    for (let i = 0; i < 4; i++) {
      const f = new THREE.PointLight(0xff9a4a, 0, 9, 2);
      f.visible = false;
      this.fireLights.push(f);
      this.scene.add(f);
    }

    const { sky, stars } = this.backdrop();
    this.sky = sky; this.stars = stars;
    this.scene.add(sky, stars);
    this.atmosphere = new Atmosphere(this.scene);

    // post: AO -> bloom + chroma + vignette -> ACES tone mapping + SMAA (the composer renders to a float buffer, so the
    // renderer's own tone mapping never runs: it is an effect here, after bloom reads the HDR values)
    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    try {
      this.ao = new N8AOPostPass(this.scene, this.camera, canvas.clientWidth || 1, canvas.clientHeight || 1);
      this.ao.configuration.aoRadius = 1.2;
      this.ao.configuration.distanceFalloff = 1.0;
      this.ao.configuration.intensity = 2.4;
      this.ao.configuration.denoiseSamples = 6;
      this.ao.configuration.denoiseRadius = 8;
      this.ao.configuration.halfRes = true;
      this.composer.addPass(this.ao);
    } catch (e) { console.warn('[chess] N8AO unavailable', e); }
    // godrays: raymarched through the key light's shadow map at half resolution, so the rays stream past the champions
    // and pillars and land on the board; linear output (gammaCorrection off) because the grade below does the encoding
    try {
      this.godrays = new GodraysPass(this.keyLight, this.camera, this.rayParams(PRESETS.high));
      this.composer.addPass(this.godrays);
    } catch (e) { console.warn('[chess] godrays unavailable', e); }
    // bloom only on what is really hot (fire, runes, lava, glints): a higher threshold keeps gold and marble crisp
    this.bloom = new BloomEffect({ blendFunction: BlendFunction.ADD, mipmapBlur: true, luminanceThreshold: 1.05, luminanceSmoothing: 0.25, intensity: 0.8, radius: 0.6, kernelSize: KernelSize.LARGE });
    this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0007, 0.0007), radialModulation: true, modulationOffset: 0.4 });
    const vignette = new VignetteEffect({ eskil: false, offset: 0.3, darkness: 0.68 });
    this.composer.addPass(new EffectPass(this.camera, this.bloom, this.chroma, vignette));
    // the grade, all merged into the one final pass (no extra render targets): AgX keeps bright gold and fire in colour
    // where ACES burned them to white, a little saturation back, and a faint film grain. (BrightnessContrastEffect is
    // left out on purpose: in this chain it lifted the dark sky into grey blotches.) The last pass
    // is the one that draws to the screen, so it is never disabled: SMAA and the grain are skipped inside it instead.
    this.smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM });
    this.grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.grain.blendMode.opacity.value = 0.045;
    this.composer.addPass(new EffectPass(this.camera,
      new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
      this.grade,
      new HueSaturationEffect({ saturation: 0.14 }),
      this.grain, this.smaa));

    const saved = localStorage.getItem('rapture-chess.quality') as Quality | 'auto' | null;
    this.auto = !saved || saved === 'auto';
    this.setQuality(saved && saved !== 'auto' ? saved : isMobile() ? 'medium' : 'high');
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // ------------------------------------------------------------------ quality
  setQuality(q: Quality): void {
    const p = PRESETS[q];
    this.quality = q;
    this.renderer.setPixelRatio(p.pixelRatio < 1 ? p.pixelRatio : Math.min(window.devicePixelRatio, p.pixelRatio));
    if (this.ao) { this.ao.enabled = p.ao; this.ao.configuration.aoSamples = p.aoSamples; }
    this.smaa.blendMode.setBlendFunction(p.smaa ? BlendFunction.NORMAL : BlendFunction.SKIP);
    this.bloom.kernelSize = p.bloomKernel;
    this.chroma.blendMode.setBlendFunction(p.chroma ? BlendFunction.NORMAL : BlendFunction.SKIP);
    this.grain.blendMode.setBlendFunction(p.chroma ? BlendFunction.OVERLAY : BlendFunction.SKIP);
    this.keyLight.castShadow = p.shadow > 0;
    if (p.shadow && this.keyLight.shadow.mapSize.x !== p.shadow) {
      this.keyLight.shadow.mapSize.set(p.shadow, p.shadow);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    if (this.godrays) {
      this.godrays.enabled = p.rays > 0 && p.shadow > 0;
      if (this.godrays.enabled) this.godrays.setParams(this.rayParams(p));
    }
    this.atmosphere.setQuality(q);
    this.showFires();
    this.setMirror(p.mirror);
    this.resize();
    for (const fn of this.qualityListeners) fn(q, this.fps);
  }
  /** Pick a fixed preset, or 'auto' to let the frame rate decide. */
  choose(q: Quality | 'auto'): void {
    this.auto = q === 'auto';
    localStorage.setItem('rapture-chess.quality', q);
    this.lowStreak = this.highStreak = 0;
    if (q !== 'auto') this.setQuality(q);
  }
  onQuality(fn: (q: Quality, fps: number) => void): void { this.qualityListeners.push(fn); }

  /** The full godrays parameter set: setParams() falls back to the library defaults for anything left out. */
  private rayParams(p: Preset) {
    return {
      color: new THREE.Color(this.rays.color), density: this.rays.density, maxDensity: this.rays.maxDensity, distanceAttenuation: this.rays.distanceAttenuation,
      raymarchSteps: Math.max(8, p.raySteps), resolutionScale: p.rays || 0.5, blur: true, gammaCorrection: false,
      upsampleQuality: p.rays >= 0.5 ? GodraysUpsampleQuality.HIGH : GodraysUpsampleQuality.LOW,
    };
  }
  /** The realm's fires: warm point lights at the braziers or over the lava; the quality decides how many burn. */
  setFires(f: FireLights): void {
    this.fireBase = f.intensity;
    this.fireLights.forEach((l, i) => {
      const at = f.positions[i];
      l.userData.on = !!at;
      if (at) l.position.set(...at);
      l.color.set(f.color);
      l.distance = f.distance;
    });
    this.showFires();
  }
  private showFires(): void {
    // spread the ones that burn: with two of four, take every other so both sides of the board are lit
    const n = FIRES[this.quality], step = n && n < 4 ? Math.floor(4 / n) : 1;
    this.fireLights.forEach((l, i) => { l.visible = !!l.userData.on && i % step === 0 && i / step < n; });
  }
  /** The pool of light on the board, falling from the key light's side. */
  setPool(p: Pool, keyPosition: [number, number, number]): void {
    this.pool.color.set(p.color);
    this.pool.intensity = p.intensity;
    this.pool.angle = p.angle;
    this.pool.position.set(...keyPosition).normalize().multiplyScalar(17);
    this.pool.target.position.set(0, 0, 0);
  }
  /** The realm's colour grade (after tone mapping). */
  setGrade(g: Grade): void { this.grade.set(g); }

  /** The realm's rays: colour and how thick the air reads. */
  setRays(r: RayColors): void {
    this.rays = r;
    if (this.godrays?.enabled) this.godrays.setParams(this.rayParams(PRESETS[this.quality]));
  }

  private mirrorSize = 0;
  private floorRadius = 9.05;
  /** The realm's polished dais round the board: the mirror (high presets) or the plain plate fills this circle; 0 = none. */
  setFloorRadius(r: number): void {
    if (r === this.floorRadius) return;
    this.floorRadius = r;
    this.atmosphere.setClearRadius(r || 5.2);
    if (r) { this.floorPlate.geometry.dispose(); this.floorPlate.geometry = new THREE.CircleGeometry(r, 64); }
    this.setMirror(this.mirrorSize);
  }
  private setMirror(size: number): void {
    this.mirrorSize = size;
    if (this.mirror) { this.scene.remove(this.mirror); this.mirror.dispose(); this.mirror = null; }
    if (!this.floorRadius) { this.floorPlate.visible = false; return; }
    if (!size) { this.floorPlate.visible = true; return; }
    this.floorPlate.visible = false;
    this.mirror = new Reflector(new THREE.CircleGeometry(this.floorRadius, 64), { textureWidth: size, textureHeight: size, color: 0x1a1a22, clipBias: 0.003 });
    this.mirror.rotation.x = -Math.PI / 2;
    this.mirror.position.y = -0.165;
    this.scene.add(this.mirror);
  }
  /** The plain floor shown when the mirror is off. */
  private readonly floorPlate = (() => {
    const m = new THREE.Mesh(new THREE.CircleGeometry(9.05, 64), new THREE.MeshStandardMaterial({ color: 0x0b0b10, roughness: 0.62, metalness: 0.35, envMapIntensity: 0.18 }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = -0.165;
    m.receiveShadow = true;
    this.scene.add(m);
    return m;
  })();

  private govern(dt: number): void {
    this.frames++;
    this.sampleTime += dt;
    if (this.sampleTime < 1.5) return;
    this.fps = this.frames / this.sampleTime;
    this.frames = 0; this.sampleTime = 0;
    for (const fn of this.qualityListeners) fn(this.quality, this.fps);
    if (!this.auto || !this.governing || document.hidden) { this.lowStreak = this.highStreak = 0; return; }
    const i = QUALITIES.indexOf(this.quality);
    if (this.fps < 58) { this.highStreak = 0; if (++this.lowStreak >= 2 && i > 0) { this.lowStreak = 0; this.setQuality(QUALITIES[i - 1]); } }
    else if (this.fps > 75) { this.lowStreak = 0; if (++this.highStreak >= 6 && i < QUALITIES.length - 1) { this.highStreak = 0; this.setQuality(QUALITIES[i + 1]); } }
    else { this.lowStreak = 0; this.highStreak = 0; }
  }

  // ------------------------------------------------------------------ sky
  /** A dome with a vertical gradient and a horizon glow, plus a starfield; the realm recolours both. */
  private backdrop(): { sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>; stars: THREE.Points } {
    const sky = new THREE.Mesh(new THREE.SphereGeometry(80, 48, 24), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x05050b) }, bottom: { value: new THREE.Color(0x120d16) }, glow: { value: new THREE.Color(0x3a2a40) },
        aurora: { value: 0 }, time: { value: 0 },
        moonDir: { value: new THREE.Vector3(0, 0.3, -1).normalize() }, moonColor: { value: new THREE.Color(0xdfe8ff) }, moonSize: { value: 0 },
        cloudColor: { value: new THREE.Color(0x2a3550) }, clouds: { value: 0 }, cloudSpeed: { value: 0.01 }, underglow: { value: 0 },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top, bottom, glow, moonDir, moonColor, cloudColor; uniform float aurora, time, moonSize, clouds, cloudSpeed, underglow; varying vec3 vP;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.07 + 5.1; a *= 0.5; } return v; }
        void main(){ vec3 d = normalize(vP); float h = d.y; vec3 c = mix(bottom, top, smoothstep(-0.2, 0.6, h));
        c += glow * pow(max(0.0, 1.0 - abs(h + 0.05) * 4.0), 2.0) * 0.6;
        // the moon: a soft disc and a wide halo (bloom picks up the disc)
        float md = max(dot(d, moonDir), 0.0);
        c += moonColor * (smoothstep(1.0 - moonSize * 0.0009, 1.0 - moonSize * 0.0006, md) * 2.4 + pow(md, 60.0) * 0.35 * step(0.001, moonSize));
        // clouds: a drifting fbm layer projected on a dome, lit from the moon side and from below (lava)
        vec2 cp = d.xz / max(0.12, h + 0.25) * 1.6 + vec2(time * cloudSpeed, time * cloudSpeed * 0.6);
        float cl = smoothstep(0.45, 0.8, fbm(cp)) * smoothstep(-0.05, 0.25, h) * clouds;
        vec3 lit = cloudColor * (0.6 + 0.8 * pow(md, 6.0)) + glow * underglow * (1.0 - smoothstep(0.0, 0.5, h));
        c = mix(c, lit, cl);
        // aurora: slow green-violet curtains high in the sky (Valhalla)
        float a = atan(d.z, d.x);
        float band = sin(a * 3.0 + time * 0.15 + sin(a * 7.0 - time * 0.1) * 0.8) * 0.5 + 0.5;
        float veil = smoothstep(0.25, 0.55, h) * (1.0 - smoothstep(0.75, 0.95, h)) * band;
        c += aurora * veil * mix(vec3(0.1, 0.9, 0.5), vec3(0.5, 0.2, 0.9), sin(a * 2.0 + time * 0.2) * 0.5 + 0.5) * 0.35;
        gl_FragColor = vec4(c, 1.0); }`,
    }));
    const n = 900, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let s = 7;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < n; i++) {
      const th = rnd() * Math.PI * 2, ph = Math.acos(rnd() * 0.9 + 0.05), r = 70;
      pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)], i * 3);
      const w = 0.4 + rnd() * 0.6;
      col.set([w, w * (0.85 + rnd() * 0.15), w * (0.8 + rnd() * 0.3)], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.3, vertexColors: true, transparent: true, opacity: 0.8, fog: false, sizeAttenuation: true }));
    return { sky, stars };
  }

  setSky(c: SkyColors, aurora = 0, stars = 0.8, extras: SkyExtras = {}): void {
    const u = this.sky.material.uniforms;
    u.moonSize.value = extras.moon?.size ?? 0;
    if (extras.moon) { (u.moonDir.value as THREE.Vector3).fromArray(extras.moon.dir).normalize(); (u.moonColor.value as THREE.Color).set(extras.moon.color); }
    u.clouds.value = extras.clouds?.amount ?? 0;
    if (extras.clouds) { (u.cloudColor.value as THREE.Color).set(extras.clouds.color); u.cloudSpeed.value = extras.clouds.speed; }
    u.underglow.value = extras.underglow ?? 0;
    (u.top.value as THREE.Color).set(c.top); (u.bottom.value as THREE.Color).set(c.bottom); (u.glow.value as THREE.Color).set(c.glow);
    u.aurora.value = aurora;
    (this.scene.fog as THREE.FogExp2).color.set(c.fog);
    (this.scene.fog as THREE.FogExp2).density = c.fogDensity;
    (this.scene.background as THREE.Color).set(c.fog);
    (this.stars.material as THREE.PointsMaterial).opacity = stars;
    this.stars.visible = stars > 0;
  }

  setAccentColors(a: THREE.ColorRepresentation, b: THREE.ColorRepresentation): void {
    this.accentLights[0].color.set(a);
    this.accentLights[1].color.set(b);
  }

  onUpdate(fn: (dt: number, t: number) => void): void { this.updaters.push(fn); }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // portrait phones: open the vertical field of view so the whole board still fits across the screen
    this.camera.fov = this.camera.aspect < 1 ? Math.min(74, 40 / this.camera.aspect) : this.attract ? 48 : 40;
    // the menu on a wide screen: slide the picture right so the board stands clear of the menu column
    const shift = this.attract && this.camera.aspect > 1.25 ? Math.round(w * 0.12) : 0;
    if (shift) this.camera.setViewOffset(w, h, -shift, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    // A hidden tab gets no animation frames, but a relayed match still has to progress (moves resolve through
    // tweens): tick the clocks coarsely while hidden so the game logic never waits on a frame that will not come.
    setInterval(() => { if (document.hidden) { tweens.update(0.25); for (const fn of this.updaters) fn(0.25, performance.now() / 1000); } }, 250);
    this.renderer.setAnimationLoop(() => {
      this.timer.update();
      const dt = Math.min(0.05, this.timer.getDelta()), t = this.timer.getElapsed();
      this.sky.material.uniforms.time.value = t;
      tweens.update(dt);
      if (this.attract) this.orbit(dt);
      else this.controls.update();
      this.atmosphere.update(dt, t);
      this.flicker(t);
      for (const fn of this.updaters) fn(dt, t);
      if (this.paused) return;
      const shaking = this.shakeLeft > 0;
      if (shaking) {
        this.shakeLeft -= dt;
        const k = this.shakeAmp * Math.max(0, this.shakeLeft) * 4;
        this.shakeOffset.set((Math.random() - 0.5) * k, (Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
        this.camera.position.add(this.shakeOffset);
      }
      this.composer.render(dt);
      if (shaking) this.camera.position.sub(this.shakeOffset);
      this.govern(dt);
    });
  }

  /** Fire flicker: two incommensurate sines per light, so no two lights pulse together. */
  private flicker(t: number): void {
    for (let i = 0; i < this.fireLights.length; i++) {
      const l = this.fireLights[i];
      if (l.visible) l.intensity = this.fireBase * (0.82 + 0.12 * Math.sin(t * 9.1 + i * 2.3) * Math.sin(t * 3.7 + i) + 0.06 * Math.sin(t * 23.0 + i * 5.0));
    }
  }

  /** A short camera tremor (a capture lands). */
  shake(amplitude = 0.06, seconds = 0.28): void { this.shakeAmp = amplitude; this.shakeLeft = seconds; }

  /** The menu camera: a slow, high circle around the board. */
  private orbit(dt: number): void {
    this.attractAngle += dt * 0.06;
    // inside both arenas' rings (Valhalla's pillars stand at 15.2 m, the Underworld's spires from 16 m), above the
    // runestones, totems and crystals (under 3.2 m) and below the stalactites
    const r = 12.6, a = this.attractAngle;
    const y = (this.camera.aspect > 1.25 ? 8.2 : 6.2) + Math.sin(a * 0.7) * 0.7;
    this.camera.position.set(Math.sin(a) * r, y, Math.cos(a) * r);
    this.camera.lookAt(this.controls.target);
  }
  setAttract(on: boolean): void {
    this.attract = on;
    this.controls.enabled = !on;
    this.resize();
    if (on) this.attractAngle = Math.atan2(this.camera.position.x, this.camera.position.z);
  }

  /** Glide the camera to a new orbit position over `seconds` (the controls keep their target). */
  flyTo(position: THREE.Vector3, seconds = 1.6): Promise<void> {
    const from = this.camera.position.clone();
    this.controls.enabled = false;
    return tweens.run(seconds, (k) => { this.camera.position.lerpVectors(from, position, k); this.camera.lookAt(this.controls.target); }, (k) => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)
      .then(() => { this.controls.enabled = true; });
  }
}
