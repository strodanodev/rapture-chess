/**
 * The stage: renderer, camera, post-processing chain (N8AO ambient occlusion, bloom, chromatic aberration,
 * vignette, ACES, SMAA), environment lighting, the sky dome and the orbit camera with board-friendly limits.
 *
 * Quality is a preset (ultra/high/medium/low) chosen by the device and then governed by the frame rate: the
 * adaptive controller steps down whenever the average dips under 58 fps and climbs back once it holds over 75.
 * Everything costly is a switch: pixel ratio, AO, the mirror floor, shadow map size, SMAA and bloom radius.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import {
  BloomEffect, ChromaticAberrationEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset, VignetteEffect, BlendFunction, KernelSize, ToneMappingEffect, ToneMappingMode,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { tweens } from './tween';

export type Quality = 'ultra' | 'high' | 'medium' | 'low';
export const QUALITIES: Quality[] = ['low', 'medium', 'high', 'ultra'];
interface Preset { pixelRatio: number; ao: boolean; aoSamples: number; mirror: number; shadow: number; smaa: boolean; bloomKernel: KernelSize; chroma: boolean }
const PRESETS: Record<Quality, Preset> = {
  ultra: { pixelRatio: 2, ao: true, aoSamples: 16, mirror: 1024, shadow: 2048, smaa: true, bloomKernel: KernelSize.LARGE, chroma: true },
  high: { pixelRatio: 1.5, ao: true, aoSamples: 8, mirror: 512, shadow: 2048, smaa: true, bloomKernel: KernelSize.MEDIUM, chroma: true },
  medium: { pixelRatio: 1.25, ao: false, aoSamples: 8, mirror: 0, shadow: 1024, smaa: true, bloomKernel: KernelSize.MEDIUM, chroma: false },
  low: { pixelRatio: 1, ao: false, aoSamples: 8, mirror: 0, shadow: 1024, smaa: false, bloomKernel: KernelSize.SMALL, chroma: false },
};

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
  quality: Quality = 'high';
  auto = true;
  fps = 60;
  private readonly timer = new THREE.Timer();
  private readonly updaters: Array<(dt: number, t: number) => void> = [];
  private readonly qualityListeners: Array<(q: Quality, fps: number) => void> = [];
  private bloom: BloomEffect;
  private ao: N8AOPostPass | null = null;
  private smaa: SMAAEffect;
  /** Set false while assets load: those frames say nothing about the game's frame rate. */
  governing = true;
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
    sc.left = sc.bottom = -6.5; sc.right = sc.top = 6.5; sc.near = 2; sc.far = 30;
    this.scene.add(this.keyLight, this.keyLight.target);
    this.rimLight = new THREE.SpotLight(0x8fb4ff, 40, 40, Math.PI / 5, 0.6, 1.4);
    this.rimLight.position.set(-6, 8, -9);
    this.scene.add(this.rimLight, this.rimLight.target);
    const a0 = new THREE.PointLight(0x38a8ff, 18, 14, 1.8), a1 = new THREE.PointLight(0xff6a2a, 18, 14, 1.8);
    a0.position.set(-5.5, 1.6, 5.5); a1.position.set(5.5, 1.6, -5.5);
    this.accentLights = [a0, a1];
    this.hemi = new THREE.HemisphereLight(0x2a2f45, 0x080608, 0.5);
    this.scene.add(a0, a1, this.hemi);

    const { sky, stars } = this.backdrop();
    this.sky = sky; this.stars = stars;
    this.scene.add(sky, stars);

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
    this.bloom = new BloomEffect({ blendFunction: BlendFunction.ADD, mipmapBlur: true, luminanceThreshold: 1.0, luminanceSmoothing: 0.3, intensity: 1.0, radius: 0.65, kernelSize: KernelSize.LARGE });
    this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0009, 0.0009), radialModulation: true, modulationOffset: 0.35 });
    const vignette = new VignetteEffect({ eskil: false, offset: 0.28, darkness: 0.62 });
    this.composer.addPass(new EffectPass(this.camera, this.bloom, this.chroma, vignette));
    // the last pass is the one that draws to the screen, so it is never disabled: SMAA is skipped inside it instead
    this.smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM });
    this.composer.addPass(new EffectPass(this.camera, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }), this.smaa));

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, p.pixelRatio));
    if (this.ao) { this.ao.enabled = p.ao; this.ao.configuration.aoSamples = p.aoSamples; }
    this.smaa.blendMode.setBlendFunction(p.smaa ? BlendFunction.NORMAL : BlendFunction.SKIP);
    this.bloom.kernelSize = p.bloomKernel;
    this.chroma.blendMode.setBlendFunction(p.chroma ? BlendFunction.NORMAL : BlendFunction.SKIP);
    if (this.keyLight.shadow.mapSize.x !== p.shadow) {
      this.keyLight.shadow.mapSize.set(p.shadow, p.shadow);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
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

  private setMirror(size: number): void {
    if (this.mirror) { this.scene.remove(this.mirror); this.mirror.dispose(); this.mirror = null; }
    if (!size) { this.floorPlate.visible = true; return; }
    this.floorPlate.visible = false;
    this.mirror = new Reflector(new THREE.PlaneGeometry(70, 70), { textureWidth: size, textureHeight: size, color: 0x1a1a22, clipBias: 0.003 });
    this.mirror.rotation.x = -Math.PI / 2;
    this.mirror.position.y = -0.165;
    this.scene.add(this.mirror);
  }
  /** The plain floor shown when the mirror is off. */
  private readonly floorPlate = (() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.MeshStandardMaterial({ color: 0x0b0b10, roughness: 0.35, metalness: 0.6, envMapIntensity: 0.8 }));
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
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top, bottom, glow; uniform float aurora, time; varying vec3 vP;
        void main(){ vec3 d = normalize(vP); float h = d.y; vec3 c = mix(bottom, top, smoothstep(-0.2, 0.6, h));
        c += glow * pow(max(0.0, 1.0 - abs(h + 0.05) * 4.0), 2.0) * 0.6;
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

  setSky(c: SkyColors, aurora = 0, stars = 0.8): void {
    const u = this.sky.material.uniforms;
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
    this.camera.fov = this.camera.aspect < 1 ? Math.min(74, 40 / this.camera.aspect) : 40;
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
      this.controls.update();
      for (const fn of this.updaters) fn(dt, t);
      this.composer.render(dt);
      this.govern(dt);
    });
  }

  /** Glide the camera to a new orbit position over `seconds` (the controls keep their target). */
  flyTo(position: THREE.Vector3, seconds = 1.6): Promise<void> {
    const from = this.camera.position.clone();
    this.controls.enabled = false;
    return tweens.run(seconds, (k) => { this.camera.position.lerpVectors(from, position, k); this.camera.lookAt(this.controls.target); }, (k) => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)
      .then(() => { this.controls.enabled = true; });
  }
}
