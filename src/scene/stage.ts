/**
 * The stage: renderer, camera, post-processing chain (N8AO ambient occlusion, godrays, bloom, chromatic aberration,
 * vignette, AgX, SMAA), environment lighting, the sky dome, the atmosphere (light shafts, ground mist) and the orbit
 * camera with board-friendly limits.
 *
 * Quality is a preset (ultra/high/medium/low/lite) chosen by the device and then governed by measured frame cost: the
 * main-thread time of each frame, the GPU time (timer queries, where the browser has them) and the frame rate, over
 * one-second windows. The governor's first lever is the render resolution inside the preset (no passes toggled, no
 * shaders rebuilt), the second is the preset itself; a preset it had to leave is barred for a while, so it never flaps
 * between two. Everything costly is a switch: pixel ratio, AO, godrays resolution and steps, the mirror floor, shadow
 * map size and cadence, the mirror's cadence, SMAA, chroma and grain.
 *
 * Every change that resizes the canvas lands at the start of a frame, right before the draw: setSize resets the canvas
 * bitmap, and a reset canvas that reaches the compositor before the next draw is a black flash.
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
import { FrameMeter, GpuTimer } from './frametimer';
import { installHeightFog } from './heightfog';
import { tweens } from './tween';

// before any material compiles: the fog chunks gain a height term (thick on the floor, thin in the air)
installHeightFog();

export type Quality = 'ultra' | 'high' | 'medium' | 'low' | 'lite';
export const QUALITIES: Quality[] = ['lite', 'low', 'medium', 'high', 'ultra'];
interface Preset {
  pixelRatio: number; ao: boolean; aoSamples: number; aoDenoise: number; mirror: number;
  /** Re-render the mirror every n frames, on the frames between shadow updates (so the two never land together). */
  mirrorEvery: number;
  shadow: number;
  /** Render the shadow map every n frames (0 = no shadows). The champions idle slowly: a shadow one frame old is invisible, and the shadow pass is a whole extra scene pass. */
  shadowEvery: number;
  smaa: boolean; bloomKernel: KernelSize; chroma: boolean;
  /** Godrays render-target scale (0 = off) and raymarch steps per pixel. */
  rays: number; raySteps: number;
}
// N8AO's denoiser has a fast path for 4, 8 and 16 samples only; the pixel ratio tops out at 1.5 (2 on a retina laptop
// is four 5760x3600 half-float targets: context loss territory, and the governor would only scale it back down)
const PRESETS: Record<Quality, Preset> = {
  ultra: { pixelRatio: 1.5, ao: true, aoSamples: 16, aoDenoise: 8, mirror: 1024, mirrorEvery: 1, shadow: 2048, shadowEvery: 1, smaa: true, bloomKernel: KernelSize.LARGE, chroma: true, rays: 0.5, raySteps: 48 },
  high: { pixelRatio: 1.5, ao: true, aoSamples: 8, aoDenoise: 4, mirror: 512, mirrorEvery: 2, shadow: 1024, shadowEvery: 2, smaa: true, bloomKernel: KernelSize.MEDIUM, chroma: true, rays: 0.5, raySteps: 32 },
  medium: { pixelRatio: 1.25, ao: false, aoSamples: 8, aoDenoise: 4, mirror: 0, mirrorEvery: 0, shadow: 1024, shadowEvery: 2, smaa: true, bloomKernel: KernelSize.MEDIUM, chroma: false, rays: 0.25, raySteps: 20 },
  low: { pixelRatio: 1, ao: false, aoSamples: 8, aoDenoise: 4, mirror: 0, mirrorEvery: 0, shadow: 1024, shadowEvery: 2, smaa: false, bloomKernel: KernelSize.SMALL, chroma: false, rays: 0, raySteps: 0 },
  // the floor for weak phone GPUs: three quarters of the CSS resolution and no shadow pass
  lite: { pixelRatio: 0.75, ao: false, aoSamples: 8, aoDenoise: 4, mirror: 0, mirrorEvery: 0, shadow: 0, shadowEvery: 0, smaa: false, bloomKernel: KernelSize.VERY_SMALL, chroma: false, rays: 0, raySteps: 0 },
};
/** Render-resolution steps inside a preset, as a share of the preset's pixel ratio: the governor's first lever. */
const SCALES = [1, 0.85, 0.72, 0.6];
/** The frame budget the governor holds: 60 fps. */
const BUDGET_MS = 1000 / 60;
const CHROMA_OFFSET = 0.0007;
const GRAIN_OPACITY = 0.045;

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

/** The godrays pass binds the key light's shadow map once and keeps it; these are the fields that make it look again. */
interface GodraysIllum { shadowMapSet: boolean; needsDepthCopy: boolean; depthCopyTarget: { dispose(): void } | null }

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
  private readonly qualityListeners: Array<(q: Quality, fps: number, scale: number) => void> = [];
  private bloom: BloomEffect;
  private ao: N8AOPostPass | null = null;
  /** Shadow-aware volumetric rays from the key light (three-good-godrays), between AO and bloom. */
  private godrays: GodraysPass | null = null;
  private rays: RayColors = { color: 0xa9c6ff, density: 1 / 70, maxDensity: 0.28, distanceAttenuation: 2 };
  private chroma: ChromaticAberrationEffect;
  private grain: NoiseEffect;
  /** Tone mapping, grade, saturation and grain; draws to the screen unless SMAA follows it. */
  private readonly finalPass: EffectPass;
  /** SMAA after tone mapping, its own pass so a preset can switch it off without rebuilding the final pass's shader. */
  private readonly smaaPass: EffectPass;
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
  private mirror: Reflector | null = null;
  /** This frame re-renders the mirror (Preset.mirrorEvery); a skipped frame keeps the last reflection and its projection. */
  private mirrorDue = true;
  private mirrorFresh = true;
  // ---- the frame loop and the governor
  private started = false;
  /** Work that must land at the start of a frame, before the draw (anything that resizes the canvas). */
  private readonly pending: Array<() => void> = [];
  /** The canvas was reset (resized): draw once even under an opaque screen, so nothing black is ever uncovered. */
  private needsPaint = false;
  private frame = 0;
  private shadowDirty = true;
  private readonly gpu: GpuTimer;
  private readonly meter = new FrameMeter();
  private scaleIndex = 0;
  private lowStreak = 0;
  private highStreak = 0;
  /** The preset the governor last had to leave, barred until `ceilingUntil`; the bar doubles each time it falls again. */
  private ceiling = QUALITIES.length - 1;
  private ceilingUntil = 0;
  private penaltyMs = 30_000;
  /** Frames before this time are not judged (a scene swap is uploading). */
  private holdUntil = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // applied as a post effect, see below
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // the draw decides each frame (Preset.shadowEvery)
    this.gpu = new GpuTimer(this.renderer);

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

    // post: AO -> godrays -> bloom + chroma + vignette -> AgX tone mapping + grade + grain -> SMAA (the composer renders
    // to a float buffer, so the renderer's own tone mapping never runs: it is an effect here, after bloom reads the HDR
    // values). Presets switch passes on and off and set uniforms; they never change blend functions, which would
    // rebuild a pass's shader (a second-long hitch and a black frame on every quality step).
    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    try {
      this.ao = new N8AOPostPass(this.scene, this.camera, canvas.clientWidth || 1, canvas.clientHeight || 1);
      this.ao.configuration.aoRadius = 1.2;
      this.ao.configuration.distanceFalloff = 1.0;
      this.ao.configuration.intensity = 2.4;
      this.ao.configuration.denoiseSamples = 4;
      this.ao.configuration.denoiseRadius = 8;
      this.ao.configuration.halfRes = true;
      // N8AO looks for transparent materials every frame and, finding any (stars, mist, shafts, glass, particles),
      // renders the scene twice more at full resolution to keep AO off them: two scene walks, sixty draws and two
      // full-screen depth copies a frame for a shade under a few soft glows
      // (the library has no typed switch for the detection; it is a plain field)
      (this.ao as unknown as { autoDetectTransparency: boolean }).autoDetectTransparency = false;
      this.ao.configuration.transparencyAware = false;
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
    this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(CHROMA_OFFSET, CHROMA_OFFSET), radialModulation: true, modulationOffset: 0.4 });
    const vignette = new VignetteEffect({ eskil: false, offset: 0.3, darkness: 0.68 });
    this.composer.addPass(new EffectPass(this.camera, this.bloom, this.chroma, vignette));
    // the grade, all merged into one pass (no extra render targets): AgX keeps bright gold and fire in colour where
    // ACES burned them to white, a little saturation back, and a faint film grain. (BrightnessContrastEffect is left
    // out on purpose: in this chain it lifted the dark sky into grey blotches.)
    this.grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.grain.blendMode.opacity.value = GRAIN_OPACITY;
    this.finalPass = new EffectPass(this.camera, new ToneMappingEffect({ mode: ToneMappingMode.AGX }), this.grade, new HueSaturationEffect({ saturation: 0.14 }), this.grain);
    this.composer.addPass(this.finalPass);
    this.smaaPass = new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM }));
    this.composer.addPass(this.smaaPass);

    const saved = localStorage.getItem('rapture-chess.quality') as Quality | 'auto' | null;
    this.auto = !saved || saved === 'auto';
    this.setQuality(saved && saved !== 'auto' ? saved : isMobile() ? 'medium' : 'high');
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // ------------------------------------------------------------------ quality
  /** Apply a preset now, at `scale` (an index into SCALES). From outside the frame loop, prefer choose(). */
  setQuality(q: Quality, scale = 0): void {
    const p = PRESETS[q];
    this.quality = q;
    this.scaleIndex = Math.min(scale, SCALES.length - 1);
    if (this.ao) { this.ao.enabled = p.ao; this.ao.configuration.aoSamples = p.aoSamples; this.ao.configuration.denoiseSamples = p.aoDenoise; }
    // SMAA is its own pass: when it is off, the final pass is the one that draws to the screen
    this.smaaPass.enabled = p.smaa;
    this.smaaPass.renderToScreen = p.smaa;
    this.finalPass.renderToScreen = !p.smaa;
    this.bloom.kernelSize = p.bloomKernel;
    this.chroma.offset.set(p.chroma ? CHROMA_OFFSET : 0, p.chroma ? CHROMA_OFFSET : 0);
    this.grain.blendMode.opacity.value = p.chroma ? GRAIN_OPACITY : 0;
    this.keyLight.castShadow = p.shadow > 0;
    if (p.shadow && this.keyLight.shadow.mapSize.x !== p.shadow) {
      this.keyLight.shadow.mapSize.set(p.shadow, p.shadow);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
      this.rebindGodrays();
    }
    this.shadowDirty = true;
    this.mirrorFresh = true;
    if (this.godrays) {
      this.godrays.enabled = p.rays > 0 && p.shadow > 0;
      if (this.godrays.enabled) this.godrays.setParams(this.rayParams(p));
    }
    this.atmosphere.setQuality(q);
    this.showFires();
    if (p.mirror !== this.mirrorSize) this.setMirror(p.mirror);
    this.applyResolution();
    for (const fn of this.qualityListeners) fn(q, this.fps, this.scale);
  }
  /** Pick a fixed preset, or 'auto' to let the frame cost decide. */
  choose(q: Quality | 'auto'): void {
    this.auto = q === 'auto';
    localStorage.setItem('rapture-chess.quality', q);
    this.lowStreak = this.highStreak = 0;
    this.ceilingUntil = 0;
    if (q !== 'auto') this.later(() => this.setQuality(q));
    else if (this.scaleIndex) this.later(() => this.setQuality(this.quality));
  }
  onQuality(fn: (q: Quality, fps: number, scale: number) => void): void { this.qualityListeners.push(fn); }
  /** The render resolution as a share of the preset's: 1 at full, down to 0.6 when the governor is holding 60 fps. */
  get scale(): number { return SCALES[this.scaleIndex]; }

  /** The preset's pixel ratio times the governor's scale, then the composer's targets to match. */
  private applyResolution(): void {
    const p = PRESETS[this.quality];
    const base = p.pixelRatio < 1 ? p.pixelRatio : Math.min(window.devicePixelRatio, p.pixelRatio);
    this.renderer.setPixelRatio(base * SCALES[this.scaleIndex]); // resets the canvas bitmap: callers paint in the same task
    this.fit(true);
  }
  /** Run `fn` at the start of the next frame (before the draw), or now if the loop is not running yet. */
  private later(fn: () => void): void {
    if (this.started) this.pending.push(fn);
    else fn();
  }
  /** The shadow map was rebuilt at a new size: the godrays pass bound the old texture once and keeps it, so make it look again. */
  private rebindGodrays(): void {
    const illum = (this.godrays as unknown as { illumPass?: GodraysIllum } | null)?.illumPass;
    if (!illum) return;
    illum.depthCopyTarget?.dispose();
    illum.depthCopyTarget = null;
    illum.needsDepthCopy = false;
    illum.shadowMapSet = false;
  }

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
    const reflect = this.mirror.onBeforeRender;
    this.mirror.onBeforeRender = (...args) => { if (this.mirrorDue) reflect.apply(this.mirror, args); };
    this.mirrorFresh = true;
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

  // ------------------------------------------------------------------ governor
  /**
   * Judge the last one-second window: step the resolution, then the preset, down when the budget is blown and up when
   * there is headroom. This runs after the frame's draw, so a step waits for the start of the next frame: a resize
   * here would reset the canvas the browser is about to show, and that empty canvas was the menu's black flash.
   */
  private govern(cpuMs: number): void {
    const w = this.meter.frame(cpuMs, this.gpu.poll());
    if (!w) return;
    this.fps = w.fps;
    for (const fn of this.qualityListeners) fn(this.quality, this.fps, this.scale);
    if (!this.auto || !this.governing || document.hidden) { this.lowStreak = this.highStreak = 0; return; }
    // the slower side of the frame; the GPU figure is 0 where the browser has no timer queries, and then only the
    // frame rate can say it is over (which, with vsync, it does)
    const load = Math.max(w.cpu, w.gpu);
    const over = w.fps < 57 || load > BUDGET_MS * 0.95;
    const under = w.fps >= 59 && load < BUDGET_MS * 0.62;
    const atFloor = this.scaleIndex === SCALES.length - 1;
    if (over) {
      this.highStreak = 0;
      // a resolution notch on the first bad second; a preset only after two in a row at the lowest resolution
      if (++this.lowStreak >= (atFloor ? 2 : 1)) { this.lowStreak = 0; this.later(() => this.stepDown()); }
    } else if (under) {
      this.lowStreak = 0;
      // resolution comes back after four good seconds, a preset after ten
      if (++this.highStreak >= (this.scaleIndex ? 4 : 10)) { this.highStreak = 0; this.later(() => this.stepUp()); }
    } else {
      this.lowStreak = 0;
      this.highStreak = Math.max(0, this.highStreak - 1);
    }
  }
  private stepDown(): void {
    const i = QUALITIES.indexOf(this.quality);
    if (this.scaleIndex < SCALES.length - 1) { this.scaleIndex++; this.applyResolution(); return; }
    if (i === 0) return;
    // bar the preset we are leaving, for longer each time it fails
    this.ceiling = i;
    this.ceilingUntil = performance.now() + this.penaltyMs;
    this.penaltyMs = Math.min(this.penaltyMs * 2, 240_000);
    this.setQuality(QUALITIES[i - 1], 1);
  }
  private stepUp(): void {
    const i = QUALITIES.indexOf(this.quality);
    if (this.scaleIndex > 0) { this.scaleIndex--; this.applyResolution(); return; }
    if (i >= QUALITIES.length - 1) return;
    if (i + 1 >= this.ceiling && performance.now() < this.ceilingUntil) return;
    this.setQuality(QUALITIES[i + 1], 1); // arrive a notch under full resolution and earn the rest
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

  // ------------------------------------------------------------------ size and the frame loop
  resize(): void { this.fit(false); }

  /**
   * Size the drawing buffer and the camera to the canvas. setSize resets the canvas bitmap even at the same size, and a
   * reset bitmap composited before the next draw is a black flash: the buffer is only touched when its size really
   * changes (or `force`, after a pixel-ratio change has already reset it), and a draw is owed right after.
   */
  private fit(force: boolean): void {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    if (!w || !h) return; // a hidden or collapsed window: zero-size render targets only raise GL errors; keep the last good size
    const pr = this.renderer.getPixelRatio();
    if (force || this.canvas.width !== Math.floor(w * pr) || this.canvas.height !== Math.floor(h * pr)) {
      this.renderer.setSize(w, h, false);
      this.composer.setSize(w, h);
      this.needsPaint = true;
      this.meter.reset();
    }
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
    this.started = true;
    this.renderer.setAnimationLoop(() => {
      const t0 = performance.now();
      // quality and resolution changes land here, before the draw: the canvas they reset is painted in this same task
      if (this.pending.length) for (const fn of this.pending.splice(0)) fn();
      this.timer.update();
      const dt = Math.min(0.05, this.timer.getDelta()), t = this.timer.getElapsed();
      this.sky.material.uniforms.time.value = t;
      tweens.update(dt);
      if (this.attract) this.orbit(dt);
      else this.controls.update();
      this.atmosphere.update(dt, t);
      this.flicker(t);
      for (const fn of this.updaters) fn(dt, t);
      if (this.paused && !this.needsPaint) { this.meter.reset(); return; }
      this.draw(dt);
      if (this.paused || performance.now() < this.holdUntil) this.meter.reset();
      else this.govern(performance.now() - t0);
    });
  }

  /** One frame through the composer: the shadow map on its cadence, the camera shake applied and undone. */
  private draw(dt: number): void {
    this.needsPaint = false;
    const every = PRESETS[this.quality].shadowEvery;
    this.frame++;
    this.renderer.shadowMap.needsUpdate = every > 0 && (this.shadowDirty || this.frame % every === 0);
    this.shadowDirty = false;
    const mirrorEvery = PRESETS[this.quality].mirrorEvery;
    this.mirrorDue = mirrorEvery <= 1 || this.mirrorFresh || this.frame % mirrorEvery === 1;
    this.mirrorFresh = false;
    const shaking = this.shakeLeft > 0;
    if (shaking) {
      this.shakeLeft -= dt;
      const k = this.shakeAmp * Math.max(0, this.shakeLeft) * 4;
      this.shakeOffset.set((Math.random() - 0.5) * k, (Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
      this.camera.position.add(this.shakeOffset);
    }
    this.gpu.begin();
    this.composer.render(dt);
    this.gpu.end();
    if (shaking) this.camera.position.sub(this.shakeOffset);
  }

  /** Leave the next `ms` of frames out of the governor's windows: the scene just changed and its first frames upload. */
  hold(ms = 1500): void { this.holdUntil = performance.now() + ms; this.meter.reset(); }

  /** Draw one frame now, even under an opaque screen: compiles every program a match needs (shadow and post variants included) while the versus screen still covers the canvas. */
  warm(): void { if (this.started) this.draw(0); }

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
    this.mirrorFresh = true;
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
