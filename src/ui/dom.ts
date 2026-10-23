/**
 * DOM helpers for the UI layer. Dynamic strings only ever go through textContent (`h(tag, props, 'text')`); the only
 * markup set as HTML is the developer-authored SVG in `icon()`.
 */
import { ICONS, type IconName } from './icons';

type Props = Partial<{ class: string; id: string; text: string; title: string; type: string; hidden: boolean; style: string; aria: Record<string, string>; data: Record<string, string>; on: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>> }> & Record<string, unknown>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = String(v);
      else if (k === 'text') e.textContent = String(v);
      else if (k === 'style') e.setAttribute('style', String(v));
      else if (k === 'aria') for (const [a, av] of Object.entries(v as Record<string, string>)) e.setAttribute(`aria-${a}`, av);
      else if (k === 'data') for (const [a, av] of Object.entries(v as Record<string, string>)) e.dataset[a] = av;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) e.addEventListener(ev, fn);
      else if (k === 'hidden') e.hidden = !!v;
      else if (k in e) (e as unknown as Record<string, unknown>)[k] = v;
      else e.setAttribute(k, String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/** A trusted, inline SVG icon. */
export function icon(name: IconName, cls = ''): HTMLElement {
  const s = document.createElement('span');
  s.className = `ico${cls ? ` ${cls}` : ''}`;
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name];
  return s.firstElementChild as HTMLElement;
}

/** Number the children of a staggered container so their entrance animations run in order. */
export function stagger(el: HTMLElement, baseMs = 0): HTMLElement {
  el.classList.add('stagger');
  if (baseMs) el.style.setProperty('--base', `${baseMs}ms`);
  [...el.children].forEach((c, i) => (c as HTMLElement).style.setProperty('--i', String(i)));
  return el;
}

/** A field of drifting embers (pure CSS); colours cycle through `colors`. */
export function embers(count: number, colors: string[]): HTMLElement {
  const box = h('div', { class: 'embers', aria: { hidden: 'true' } });
  let s = 11;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < count; i++) {
    const e = h('i');
    e.style.cssText = `left:${(rnd() * 100).toFixed(1)}%;--s:${(2 + rnd() * 3).toFixed(1)}px;--d:${(7 + rnd() * 9).toFixed(1)}s;--delay:${(-rnd() * 14).toFixed(1)}s;--dx:${((rnd() - 0.5) * 120).toFixed(0)}px;--c:${colors[i % colors.length]}`;
    box.append(e);
  }
  return box;
}

let toastBox: HTMLElement | null = null;
/** A short notice at the top of the screen. */
export function toast(text: string, kind: 'info' | 'err' = 'info', ico: IconName = kind === 'err' ? 'alert' : 'spark'): void {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', aria: { live: 'polite' } }); document.body.append(toastBox); }
  const t = h('div', { class: `toast${kind === 'err' ? ' err' : ''}` }, icon(ico), h('span', { text }));
  toastBox.append(t);
  while (toastBox.children.length > 3) toastBox.firstElementChild!.remove();
  setTimeout(() => t.remove(), 3300);
}

/** A modal dialog over everything; resolves when it closes. */
export function modal(title: string, body: HTMLElement, opts: { wide?: boolean; onClose?: () => void } = {}): { close(): void; root: HTMLElement } {
  const close = () => {
    scrim.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => scrim.remove(), 200);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const closeBtn = h('button', { class: 'icon-btn close', title: 'Close', aria: { label: 'Close' }, on: { click: close } }, icon('close'));
  const panel = h('div', { class: 'modal panel frame', role: 'dialog', aria: { modal: 'true', label: title }, style: opts.wide ? 'width:min(860px,100%)' : '' },
    h('div', { class: 'panel-head' }, h('h2', { text: title }), closeBtn),
    h('div', { class: 'panel-body' }, body));
  const scrim = h('div', { class: 'scrim', on: { pointerdown: (e) => { if (e.target === scrim) close(); } } }, panel);
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);
  closeBtn.focus({ preventScroll: true });
  return { close, root: panel };
}
