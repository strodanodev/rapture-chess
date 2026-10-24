/**
 * The PWA shell: registers the service worker, forces the install on phones and tablets (the game plays only from
 * the home screen, where the manifest's `display: fullscreen` applies), and makes the first tap enter fullscreen
 * while the page is still inside a browser tab.
 *
 * Loaded from index.html beside main.ts: the game boots underneath while the gate is up, so the install opens straight
 * into the menu. The gate never shows inside the arcade iframe or for a placed LitNode match (`?match=`), on desktop,
 * or once the page already runs standalone.
 *
 * Android: `beforeinstallprompt` gives a real Install button; browsers that hold it back get the menu steps.
 * iOS: there is no install API, so the gate walks through Share -> Add to Home Screen (Safari and Chrome on iOS 16.4+).
 * After SKIP_MS an underlined "continue in the browser" link appears, for in-app browsers that cannot install at all.
 * Set SKIP_MS to 0 to remove that escape.
 */
import './install.css';

type InstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

const SKIP_MS = 12_000;
const ua = navigator.userAgent;
const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const android = /Android/.test(ua);
const mobile = iOS || android;
const framed = window.self !== window.top;
const placedMatch = new URLSearchParams(location.search).has('match');
const standalone = (): boolean =>
  matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

// ------------------------------------------------------------------ service worker (production builds only)
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  // main.ts awaits at the top level, so in the bundle this can run after the load event: register at once in that case
  const register = () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* http preview, private mode */ }); };
  if (document.readyState === 'complete') register(); else addEventListener('load', register);
}

// ------------------------------------------------------------------ fullscreen on the first tap (phone in a browser tab)
if (mobile && !framed && !standalone() && document.documentElement.requestFullscreen) {
  const enter = (e: Event) => {
    if (document.fullscreenElement || (e.target as Element | null)?.closest('#pwa-gate')) return;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => { /* iPhone Safari: no element fullscreen */ });
  };
  addEventListener('pointerup', enter, { passive: true });
}

// ------------------------------------------------------------------ the install gate
let deferred: InstallPromptEvent | null = null;
let installed = false;
let gate: HTMLElement | null = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallPromptEvent; render(); });
addEventListener('appinstalled', () => { deferred = null; installed = true; render(); });

const SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M12 8v8M8 12h8"/></svg>';
const MENU_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const HOME_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/></svg>';

// developer-authored markup only: nothing here comes from the network or the player
const step = (n: number, iconSvg: string, html: string): string => `<li><b>${n}</b>${iconSvg}<span>${html}</span></li>`;

const steps = (): string => {
  if (installed) return step(1, HOME_ICON, 'Installed. Open <em>Rapture Chess</em> from your home screen.');
  if (iOS) {
    const canInstall = /Safari|CriOS/.test(ua) && !/FxiOS|EdgiOS|OPT\//.test(ua);
    return (canInstall ? '' : step(0, HOME_ICON, 'Open this page in <em>Safari</em> first.')) +
      step(1, SHARE_ICON, 'Tap <em>Share</em> in the browser bar.') +
      step(2, PLUS_ICON, 'Choose <em>Add to Home Screen</em>, then <em>Add</em>.') +
      step(3, HOME_ICON, 'Open <em>Rapture Chess</em> from your home screen.');
  }
  if (deferred) return '';
  return step(1, MENU_ICON, 'Open the browser menu.') +
    step(2, PLUS_ICON, 'Choose <em>Install app</em> or <em>Add to Home screen</em>.') +
    step(3, HOME_ICON, 'Open <em>Rapture Chess</em> from your home screen.');
};

function render(): void {
  if (!gate) return;
  gate.innerHTML = `
    <div class="g-in">
      <img class="g-emb" src="/brand/emblem.webp" alt="" />
      <img class="g-title" src="/brand/rapture-chess.webp" alt="Rapture Chess" />
      <h2>${installed ? 'Ready' : 'Install to play'}</h2>
      <p>${installed ? 'Rapture Chess is on your home screen and plays full screen from there.'
        : 'Rapture Chess plays full screen from your home screen. It takes a few seconds, with nothing to download from a store.'}</p>
      <ol>${steps()}</ol>
      ${deferred && !installed ? '<button class="btn primary lg" id="pwa-install"><span>Install Rapture Chess</span></button>' : ''}
      ${installed ? '' : '<span class="g-note">Free, no store, updates itself.</span>'}
      ${SKIP_MS > 0 && !installed ? '<button class="g-skip" id="pwa-skip">Continue in the browser</button>' : ''}
    </div>`;
  gate.querySelector<HTMLButtonElement>('#pwa-install')?.addEventListener('click', async () => {
    const ev = deferred;
    if (!ev) return;
    deferred = null;
    try {
      await ev.prompt();
      const { outcome } = await ev.userChoice;
      if (outcome === 'dismissed') deferred = ev; // Chrome lets the same event prompt again later
    } catch { /* the event was already used */ }
    render();
  });
  const skip = gate.querySelector<HTMLButtonElement>('#pwa-skip');
  if (skip) {
    setTimeout(() => skip.classList.add('on'), SKIP_MS);
    skip.addEventListener('click', () => gate?.classList.add('hide'));
  }
}

if (mobile && !framed && !placedMatch && !standalone()) {
  gate = document.createElement('div');
  gate.id = 'pwa-gate';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-label', 'Install Rapture Chess');
  document.body.appendChild(gate);
  render();
  // a home-screen launch never reaches here; a tab that turns standalone (Android "Open" right after the install) does
  for (const mode of ['standalone', 'fullscreen']) {
    matchMedia(`(display-mode: ${mode})`).addEventListener('change', () => { if (standalone()) gate?.classList.add('hide'); });
  }
}
