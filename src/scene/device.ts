/**
 * How much the device can be asked for at the start, before the frame governor has measured anything. A guess from
 * what the browser tells: the governor corrects it within seconds either way, but a start too high costs the first
 * screens a stall while shaders compile and then a step down.
 *
 *   desktop  a laptop or desktop GPU
 *   phone    a recent phone or tablet
 *   weak     an older or small phone: an iPhone on iOS 15 or older or with a 4.7"/5.4"/5.8" screen (8, SE, X, XS,
 *            11 Pro, 12/13 mini), or an Android with 4 GB of memory or less, or 4 cores or fewer
 *
 * iPhones are capped one step under Android phones of their tier: Safari has no GPU timer queries, so on an iPhone
 * the governor only sees the frame rate and a start that is too high shows as dropped frames before it can react.
 */
export type DeviceTier = 'desktop' | 'phone' | 'weak';

const ua = navigator.userAgent;
export const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
export const iPhone = /iPhone|iPod/.test(ua);
const android = /Android/.test(ua);
const coarse = matchMedia('(pointer: coarse)').matches;
const short = Math.min(screen.width, screen.height);
const iosMajor = Number(/OS (\d+)_/.exec(ua)?.[1] ?? 0);
const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
const cores = navigator.hardwareConcurrency || 8;

export const isMobile = (): boolean => coarse || short < 820;

export const deviceTier: DeviceTier = (() => {
  if (!iOS && !android && !coarse && short >= 820) return 'desktop';
  if (iPhone && ((iosMajor > 0 && iosMajor <= 15) || short <= 375)) return 'weak';
  if (android && (memory <= 4 || cores <= 4)) return 'weak';
  return 'phone';
})();

/** A laptop or desktop running the page on its integrated GPU. Chrome on Windows ignores `powerPreference` and puts
 *  WebGL on the integrated chip of a two-GPU laptop. Measured on an Iris Xe: High holds 15 fps and only Lite holds
 *  60, so it starts there and the governor climbs if the GPU has more to give. */
export const integratedGpu = (renderer: string): boolean =>
  /\bIntel\b(?!.*\bArc\b)|Radeon(\(TM\))? Graphics|SwiftShader|llvmpipe|Basic Render/i.test(renderer);

/** The preset a device starts at when the quality is left to the governor, and the resolution step inside it. */
export const startQuality = (renderer = ''): { quality: 'lite' | 'low' | 'medium' | 'high'; scale: number } =>
  deviceTier === 'desktop' ? (integratedGpu(renderer) ? { quality: 'lite', scale: 2 } : { quality: 'high', scale: 0 })
    : { quality: deviceTier === 'weak' ? 'lite' : iOS ? 'low' : 'medium', scale: 0 };
