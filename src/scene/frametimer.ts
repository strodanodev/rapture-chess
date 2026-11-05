/**
 * Frame timing for the quality governor: the main-thread cost of a frame (from the start of the loop to the end of the
 * composer render), the GPU cost (EXT_disjoint_timer_query_webgl2 where the browser has it: Chrome, Edge and Firefox;
 * Safari reports 0) and the frame rate, summed over one-second windows. On a 60 Hz display vsync holds the frame rate
 * at 60 whatever the headroom, so the frame rate alone cannot say when quality may go up: the load can.
 *
 * Hitches longer than a quarter of a second (asset loads, shader compiles, a tab switch) are left out of the windows:
 * they say nothing about the steady frame rate, and reacting to them is what made the presets flap.
 */
import type * as THREE from 'three';

export interface FrameWindow {
  fps: number;
  /** Mean main-thread ms per frame. */
  cpu: number;
  /** Mean GPU ms per frame, 0 where the timer extension is missing. */
  gpu: number;
  frames: number;
}

interface TimerExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** Latest finished GPU frame time in ms, 0 when unavailable. */
  last = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = (this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) ?? null;
  }

  get available(): boolean { return !!this.ext; }

  begin(): void {
    if (!this.ext || this.active || this.pending.length > 4) return;
    this.active = this.gl.createQuery();
    if (this.active) this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.active);
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Collect the finished queries (they complete in order) and return the latest GPU frame time in ms, or 0. */
  poll(): number {
    if (!this.ext) return 0;
    const gl = this.gl;
    while (this.pending.length && gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = this.pending.shift()!;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) this.last = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      gl.deleteQuery(q);
    }
    return this.last;
  }
}

export class FrameMeter {
  private lastAt = 0;
  private frames = 0;
  private time = 0;
  private cpu = 0;
  private gpu = 0;
  private gpuN = 0;

  /** Forget the window in progress (a pause, a hidden tab, a load: the next frames start a fresh one). */
  reset(): void {
    this.lastAt = 0;
    this.frames = this.time = this.cpu = this.gpu = this.gpuN = 0;
  }

  /** Count a drawn frame; returns the window's figures once a second of frames has accumulated. */
  frame(cpuMs: number, gpuMs: number): FrameWindow | null {
    const now = performance.now();
    const wall = this.lastAt ? now - this.lastAt : 0;
    this.lastAt = now;
    if (wall <= 0 || wall > 250) return null;
    this.frames++;
    this.time += wall;
    this.cpu += cpuMs;
    if (gpuMs > 0) { this.gpu += gpuMs; this.gpuN++; }
    if (this.time < 1000) return null;
    const w: FrameWindow = { fps: this.frames * 1000 / this.time, cpu: this.cpu / this.frames, gpu: this.gpuN ? this.gpu / this.gpuN : 0, frames: this.frames };
    this.frames = this.time = this.cpu = this.gpu = this.gpuN = 0;
    return w;
  }
}
