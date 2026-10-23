/**
 * Screens and the transitions between them. A screen is a full-viewport layer under #ui; `go()` fades the old one out
 * and staggers the new one in, or (`wipe`) closes a gilded iris over the whole view, swaps, and opens it again.
 * Opaque screens tell the stage it may stop drawing: nothing behind them is visible.
 */
import { h, icon } from './dom';

export type ScreenId = 'home' | 'play' | 'armory' | 'shop' | 'ranks' | 'settings' | 'versus' | 'match';
export interface Screen {
  id: ScreenId;
  el: HTMLElement;
  /** Covers the canvas completely: the 3D scene can pause while it shows. */
  opaque?: boolean;
  enter?(from: ScreenId | null): void;
  leave?(): void;
}

const root = document.getElementById('ui')!;
const iris = h('div', { class: 'iris', aria: { hidden: 'true' } }, h('div', { class: 'iris-ring' }), h('div', { class: 'iris-core' }));
document.body.append(iris);

const screens = new Map<ScreenId, Screen>();
const listeners: Array<(s: Screen) => void> = [];
let current: Screen | null = null;
let busy: Promise<void> = Promise.resolve();
const stack: ScreenId[] = [];

export function register(s: Screen): void {
  screens.set(s.id, s);
  s.el.classList.add('screen');
  s.el.hidden = true;
  root.append(s.el);
}
export const onScreen = (fn: (s: Screen) => void): void => { listeners.push(fn); };
export const currentScreen = (): ScreenId | null => current?.id ?? null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Close the iris over everything, run `swap`, open it again. */
export async function wipe(swap: () => void | Promise<void>): Promise<void> {
  iris.classList.remove('open');
  iris.classList.add('closing');
  await wait(420);
  await swap();
  iris.classList.remove('closing');
  iris.classList.add('open');
  await wait(520);
  iris.classList.remove('open');
}

/** Show a screen. `before` runs while the iris is closed (a wipe) or before the swap: the place to rebuild the scene. */
export function go(id: ScreenId, opts: { wipe?: boolean; push?: boolean; before?: () => void | Promise<void> } = {}): Promise<void> {
  busy = busy.then(async () => {
    const next = screens.get(id);
    if (!next || next === current) return;
    const prev = current;
    if (opts.push !== false && prev && prev.id !== 'versus' && prev.id !== 'match') stack.push(prev.id);
    const swap = () => {
      if (prev) { prev.el.hidden = true; prev.el.classList.remove('in', 'out'); prev.leave?.(); }
      current = next;
      next.el.hidden = false;
      next.el.classList.remove('out');
      void next.el.offsetWidth;
      next.el.classList.add('in');
      next.enter?.(prev?.id ?? null);
      for (const fn of listeners) fn(next);
    };
    if (opts.wipe) { await wipe(async () => { await opts.before?.(); swap(); }); return; }
    if (prev) { prev.el.classList.add('out'); await wait(200); }
    await opts.before?.();
    swap();
  });
  return busy;
}

/** Back to the screen that opened this one (home if none). */
export function back(): Promise<void> {
  const to = stack.pop() ?? 'home';
  return go(to, { push: false });
}
export function resetStack(): void { stack.length = 0; }

/** The shared page chrome for a menu screen: back button, title, and a slot on the right. */
export function pageHead(title: string, kicker: string, right?: HTMLElement | null): HTMLElement {
  return h('header', { class: 'page-head' },
    h('button', { class: 'icon-btn back', title: 'Back', aria: { label: 'Back' }, on: { click: () => void back() } }, icon('back')),
    h('div', { class: 'page-title' }, h('span', { class: 'kicker', text: kicker }), h('h1', { class: 'display', text: title })),
    h('div', { class: 'page-right' }, right ?? null));
}
