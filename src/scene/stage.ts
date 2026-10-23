/**
 * The stage: renderer, camera, post-processing chain (N8AO ambient occlusion, bloom, chromatic aberration,
 * vignette, SMAA), environment lighting, the backdrop and the orbit camera with board-friendly limits.
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

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;
  readonly keyLight: THREE.DirectionalLight;
  readonly accentLights: [THREE.PointLight, THREE.PointLight];
  private readonly timer = new THREE.Timer();
  private readonly updaters: Array<(dt: number, t: number) => void> = [];
  private bloom!: BloomEffect;
  private mirror: Reflector | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // applied as a post effect, see below
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
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

    // lights: warm key with soft shadows, cool rim, two element-coloured accents the match recolours
    this.keyLight = new THREE.DirectionalLight(0xfff1dc, 2.2);
    this.keyLight.position.set(5, 11, 6);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.00025;
    this.keyLight.shadow.normalBias = 0.02;
    const sc = this.keyLight.shadow.camera;
    sc.left = sc.bottom = -6.5; sc.right = sc.top = 6.5; sc.near = 2; sc.far = 30;
    this.scene.add(this.keyLight, this.keyLight.target);
    const rim = new THREE.SpotLight(0x8fb4ff, 40, 40, Math.PI / 5, 0.6, 1.4);
    rim.position.set(-6, 8, -9);
    this.scene.add(rim, rim.target);
    const a0 = new THREE.PointLight(0x38a8ff, 18, 14, 1.8), a1 = new THREE.PointLight(0xff6a2a, 18, 14, 1.8);
    a0.position.set(-5.5, 1.6, 5.5); a1.position.set(5.5, 1.6, -5.5);
    this.accentLights = [a0, a1];
    this.scene.add(a0, a1, new THREE.HemisphereLight(0x2a2f45, 0x080608, 0.5));

    this.scene.add(this.backdrop());
    this.mirror = this.floor();
    this.scene.add(this.mirror);

    // post: AO -> bloom + chroma + vignette -> ACES tone mapping + SMAA (the composer renders to a float buffer, so the
    // renderer's own tone mapping never runs: it is an effect here, after bloom reads the HDR values)
    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    try {
      const ao = new N8AOPostPass(this.scene, this.camera, canvas.clientWidth || 1, canvas.clientHeight || 1);
      ao.configuration.aoRadius = 1.2;
      ao.configuration.distanceFalloff = 1.0;
      ao.configuration.intensity = 2.4;
      ao.configuration.aoSamples = 12;
      ao.configuration.denoiseSamples = 6;
      ao.configuration.denoiseRadius = 8;
      this.composer.addPass(ao);
    } catch (e) { console.warn('[chess] N8AO unavailable', e); }
    this.bloom = new BloomEffect({ blendFunction: BlendFunction.ADD, mipmapBlur: true, luminanceThreshold: 1.0, luminanceSmoothing: 0.3, intensity: 1.0, radius: 0.65, kernelSize: KernelSize.LARGE });
    const chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0009, 0.0009), radialModulation: true, modulationOffset: 0.35 });
    const vignette = new VignetteEffect({ eskil: false, offset: 0.28, darkness: 0.62 });
    this.composer.addPass(new EffectPass(this.camera, this.bloom, chroma, vignette));
    this.composer.addPass(new EffectPass(this.camera, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }), new SMAAEffect({ preset: SMAAPreset.HIGH })));

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** A dark dome with a faint horizon glow and a starfield, so the void has depth. */
  private backdrop(): THREE.Group {
    const g = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(60, 48, 24), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x05050b) }, bottom: { value: new THREE.Color(0x120d16) }, glow: { value: new THREE.Color(0x3a2a40) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top, bottom, glow; varying vec3 vP;
        void main(){ float h = normalize(vP).y; vec3 c = mix(bottom, top, smoothstep(-0.2, 0.6, h));
        c += glow * pow(max(0.0, 1.0 - abs(h + 0.05) * 4.0), 2.0) * 0.6; gl_FragColor = vec4(c, 1.0); }`,
    }));
    g.add(dome);
    const n = 900, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let s = 7;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < n; i++) {
      const th = rnd() * Math.PI * 2, ph = Math.acos(rnd() * 0.9 + 0.05), r = 50;
      pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)], i * 3);
      const w = 0.4 + rnd() * 0.6;
      col.set([w, w * (0.85 + rnd() * 0.15), w * (0.8 + rnd() * 0.3)], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.22, vertexColors: true, transparent: true, opacity: 0.8, fog: false, sizeAttenuation: true })));
    return g;
  }

  /** A black mirror floor under the frame: the pieces and the gold reflect into the dark. */
  private floor(): Reflector {
    const m = new Reflector(new THREE.PlaneGeometry(70, 70), { textureWidth: 1024, textureHeight: 1024, color: 0x1a1a22, clipBias: 0.003 });
    m.rotation.x = -Math.PI / 2;
    m.position.y = -0.165;
    return m;
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
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    this.renderer.setAnimationLoop(() => {
      this.timer.update();
      const dt = Math.min(0.05, this.timer.getDelta()), t = this.timer.getElapsed();
      tweens.update(dt);
      this.controls.update();
      for (const fn of this.updaters) fn(dt, t);
      this.composer.render(dt);
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
