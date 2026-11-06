/**
 * The PWA shell: registers the service worker, takes the page full screen on the player's taps, and keeps the
 * browser's install offer for the main menu (homeScreen shows "Install app" while there is one):
 *
 * - Every tap that lands while the page is not full screen asks for full screen, on phones and desktops alike (the
 *   browser bars hide). Full screen needs the activation of a tap, so it waits for the first one.
 * - Where the browser offers an install (`beforeinstallprompt`: Chrome, Edge, Samsung Internet), a phone's first tap
 *   opens the browser's own install dialog instead; the dialog uses up that tap, so full screen follows on the next.
 *   A later `beforeinstallprompt` (Chrome fires one again after a dismissal, on its own schedule) is shown the same
 *   way. On a desktop the offer waits for the menu.
 *
 * iPhone Safari has neither: no install API and no full screen for a page. There the menu entry explains Share, then
 * "Add to Home Screen", and the manifest and the apple-mobile-web-app tags make that launch open without browser bars.
 *
 * Loaded from index.html beside main.ts. Nothing runs inside the arcade iframe or once installed.
 */
import { toast } from '../ui/dom';

type InstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & { webkitFullscreenElement?: Element | null };

const ua = navigator.userAgent;
const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const mobile = iOS || /Android/.test(ua);
const framed = window.self !== window.top;
export const standalone = (): boolean =>
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
const listeners = new Set<() => void>();
const changed = (): void => { for (const fn of listeners) fn(); };
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallPromptEvent; changed(); });
addEventListener('appinstalled', () => { deferred = null; changed(); });

/** What the menu can offer: 'prompt' (the browser's install dialog), 'ios' (Add to Home Screen steps) or null. */
export function installOffer(): 'prompt' | 'ios' | null {
  if (framed || standalone()) return null;
  if (deferred) return 'prompt';
  return iOS ? 'ios' : null;
}

/** Calls fn whenever the install offer appears or goes; returns the unsubscribe. */
export function onInstallChange(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

const fullscreen = (): boolean => !!(document.fullscreenElement ?? (document as FsDocument).webkitFullscreenElement);

function enterFullscreen(): void {
  const root = document.documentElement as FsElement;
  try {
    if (root.requestFullscreen) void root.requestFullscreen({ navigationUI: 'hide' }).catch(() => { /* not allowed here */ });
    else void root.webkitRequestFullscreen?.(); // iPadOS before 16.4
  } catch { /* iPhone Safari: no page full screen */ }
}

/** Opens the browser's install dialog, or on iOS says how to add the game to the home screen. */
export async function install(): Promise<void> {
  if (deferred) {
    const ev = deferred;
    deferred = null;
    changed();
    try {
      await ev.prompt();
      await ev.userChoice;
    } catch { /* already used, or the browser declined to show it */ }
    return;
  }
  if (iOS) toast('Tap Share, then “Add to Home Screen” to play full screen');
}

if (!framed && !standalone()) {
  addEventListener('pointerup', (e) => {
    if (standalone()) return;
    // the menu's install entry runs its own dialog on this tap: leave the activation to it
    if (e.target instanceof Element && e.target.closest('[data-install]')) return;
    if (mobile && deferred) { void install(); return; }
    if (!fullscreen()) enterFullscreen();
  }, { passive: true, capture: true });
}
