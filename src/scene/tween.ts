/** A tiny tween clock: every animation on the board is a function of eased 0..1 time. */
export const ease = {
  outCubic: (k: number) => 1 - Math.pow(1 - k, 3),
  inOutCubic: (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  outBack: (k: number) => 1 + 2.70158 * Math.pow(k - 1, 3) + 1.70158 * Math.pow(k - 1, 2),
  outQuad: (k: number) => 1 - (1 - k) * (1 - k),
  linear: (k: number) => k,
};

interface Tween { t: number; d: number; fn: (k: number) => void; easing: (k: number) => number; resolve: () => void; delay: number }

export class Tweens {
  private list: Tween[] = [];
  /** Run `fn(k)` with k eased from 0 to 1 over `seconds`; resolves when done. */
  run(seconds: number, fn: (k: number) => void, easing = ease.outCubic, delay = 0): Promise<void> {
    return new Promise((resolve) => { this.list.push({ t: 0, d: Math.max(1e-3, seconds), fn, easing, resolve, delay }); });
  }
  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const tw = this.list[i];
      if (tw.delay > 0) { tw.delay -= dt; if (tw.delay > 0) continue; }
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.d);
      tw.fn(tw.easing(k));
      if (k >= 1) { this.list.splice(i, 1); tw.resolve(); }
    }
  }
}
export const tweens = new Tweens();
export const wait = (seconds: number): Promise<void> => tweens.run(seconds, () => {}, ease.linear);
