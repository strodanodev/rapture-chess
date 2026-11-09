/**
 * The brand art: the emblem (the winged caduceus), the Rapture Chess title (RAPTURE in bevelled gold from
 * scripts/render-logo.py over the chrome CHESS logo, composed by scripts/build-lockup.py) and the Gods vs Titans mark
 * the game belongs to. All are plain images in public/brand, versioned by name (the service worker caches them for good).
 */
import { h } from './dom';

const BRAND = `${import.meta.env.BASE_URL}brand/`;
export const EMBLEM_URL = `${BRAND}emblem.webp`;
export const TITLE_URL = `${BRAND}rapture-chess.2.webp`;
export const GVT_URL = `${BRAND}gods-vs-titans.webp`;

const img = (src: string, cls: string, alt: string, eager = false): HTMLImageElement => {
  const i = h('img', { class: cls, alt, decoding: 'async', draggable: false, loading: eager ? 'eager' : 'lazy' });
  i.src = src;
  return i;
};

export const emblem = (cls = 'emblem'): HTMLImageElement => img(EMBLEM_URL, cls, '', true);

/** The game title as an image, with a light sweep across the letters and a few sparks rising off them (CSS only). */
export function titleArt(cls = ''): HTMLElement {
  const sparks = h('span', { class: 'title-sparks', aria: { hidden: 'true' } });
  for (let i = 0; i < 12; i++) {
    const s = h('i');
    s.style.cssText = `left:${6 + ((i * 37) % 88)}%;--d:${2.4 + (i % 4) * 0.7}s;--delay:${-(i * 0.53).toFixed(2)}s;--dx:${((i % 5) - 2) * 9}px`;
    sparks.append(s);
  }
  return h('span', { class: `title-art ${cls}`.trim(), style: `--mask:url("${TITLE_URL}")` },
    img(TITLE_URL, 'title-img', 'Rapture Chess', true), h('span', { class: 'title-shine', aria: { hidden: 'true' } }), sparks);
}

/** The Gods vs Titans mark, small: "a Gods vs Titans game". */
export function gvtMark(cls = ''): HTMLElement {
  return h('span', { class: `gvt-mark ${cls}`.trim() }, h('span', { class: 'gvt-kicker', text: 'A' }), img(GVT_URL, 'gvt-img', 'Gods vs Titans', true), h('span', { class: 'gvt-kicker', text: 'game' }));
}
