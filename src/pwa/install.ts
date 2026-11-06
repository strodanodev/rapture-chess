/**
 * The PWA shell: registers the service worker and, on a phone or tablet still inside a browser tab, takes the page as
 * far towards an installed, full-screen app as the browser allows, with no screen of instructions in between:
 *
 * - Where the browser offers an install (`beforeinstallprompt`: Chrome, Edge, Samsung Internet on Android), the
 *   player's first tap opens the browser's own install dialog. A later `beforeinstallprompt` (Chrome fires one again
 *   after a dismissal, on its own schedule) is shown the same way on the next tap.
 * - Every other tap that lands while the page is not full screen asks for full screen (the browser bars hide). Both
 *   need the activation of a tap, and the install dialog uses it up, so they take turns.
 *
 * iPhone Safari has neither: no install API and no full screen for a page. There the manifest and the
 * apple-mobile-web-app tags make a home-screen launch open without browser bars, and the layout keeps to the safe
 * areas either way.
 *
 * Loaded from index.html beside main.ts. Nothing runs inside the arcade iframe, on desktop, or once installed.
 */
type InstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & { webkitFullscreenElement?: Element | null };

const ua = navigator.userAgent;
const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const mobile = iOS || /Android/.test(ua);
const framed = window.self !== window.top;
const standalone = (): boolean =>
  matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

// ------------------------------------------------------------------ service worker (production builds only)
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  // main.ts awaits at the top level, so in the bundle this can run after the load event: register at once in that case
  const register = () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* http preview, private mode */ }); };
  if (document.readyState === 'complete') register(); else addEventListener('load', register);
}

// ------------------------------------------------------------------ install and full screen, on the player's taps
let deferred: InstallPromptEvent | null = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallPromptEvent; });
addEventListener('appinstalled', () => { deferred = null; });

const fullscreen = (): boolean => !!(document.fullscreenElement ?? (document as FsDocument).webkitFullscreenElement);

function enterFullscreen(): void {
  const root = document.documentElement as FsElement;
  try {
    if (root.requestFullscreen) void root.requestFullscreen({ navigationUI: 'hide' }).catch(() => { /* not allowed here */ });
    else void root.webkitRequestFullscreen?.(); // iPadOS before 16.4
  } catch { /* iPhone Safari: no page full screen */ }
}

async function install(ev: InstallPromptEvent): Promise<void> {
  try {
    await ev.prompt();
    await ev.userChoice;
  } catch { /* already used, or the browser declined to show it */ }
}

if (mobile && !framed && !standalone()) {
  addEventListener('pointerup', () => {
    if (standalone()) return;
    if (deferred) { const ev = deferred; deferred = null; void install(ev); return; }
    if (!fullscreen()) enterFullscreen();
  }, { passive: true, capture: true });
}
