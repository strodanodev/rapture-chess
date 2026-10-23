/** The champion card: art in a frame coloured by Kind (rarity), an element gem, the name plate, and a foil that follows the pointer. */
import type { Card } from '../roster';
import { ELEMENT_COLOR, PIECE_NAME } from '../roster';
import type { PieceType } from '../rules/chessRules';
import { h, icon } from './dom';

export const ART = (slug: string): string => `${import.meta.env.BASE_URL}art/${slug}.webp`;
/** The piece each Kind fights as. */
export const ROLE_OF: Record<Card['kind'], string> = { God: 'King or Queen', Titan: 'Rook', King: 'Bishop', Demigod: 'Knight', Mortal: 'Pawn' };
export const RARITY: Record<Card['kind'], string> = { God: 'Legendary', Titan: 'Epic', King: 'Rare', Demigod: 'Uncommon', Mortal: 'Common' };
const finePointer = matchMedia('(pointer: fine)').matches;

export function championCard(card: Card, opts: { owned?: boolean; type?: PieceType | null; button?: boolean; eager?: boolean; tilt?: boolean } = {}): HTMLElement {
  const img = h('img', { alt: card.name, loading: opts.eager ? 'eager' : 'lazy', decoding: 'async', draggable: false });
  img.src = ART(card.slug);
  const el = h(opts.button ? 'button' : 'div', { class: 'ccard', data: { kind: card.kind }, style: `--el:${ELEMENT_COLOR[card.element]}`, title: opts.button ? card.name : undefined },
    h('div', { class: 'inner' },
      h('div', { class: 'art' }, img, h('span', { class: 'kind', text: card.kind }), h('span', { class: 'gem', title: card.element })),
      h('div', { class: 'cplate' },
        h('div', { class: 'name', text: card.name }),
        h('div', { class: 'sub', text: opts.type ? `${PIECE_NAME[opts.type]} · ${card.faction}` : `${ROLE_OF[card.kind]} · ${card.faction}` }))),
    h('span', { class: 'foil' }),
    opts.owned ? h('span', { class: 'badge owned' }, icon('check'), 'Held') : null);
  if ((opts.tilt ?? opts.button) && finePointer) tilt(el);
  return el;
}

/** A face-down card (the pack reveal). */
export function cardBack(): HTMLElement {
  return h('div', { class: 'ccard back' }, h('div', { class: 'inner' }, icon('emblem')));
}

/** Pointer-follow tilt and foil: transform only, so it stays on the compositor. */
export function tilt(el: HTMLElement, max = 10): void {
  let raf = 0;
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      el.style.transform = `perspective(700px) rotateY(${(x - 0.5) * max}deg) rotateX(${(0.5 - y) * max}deg) translateZ(0)`;
      el.style.setProperty('--fx', `${x * 100}%`);
      el.style.setProperty('--fy', `${y * 100}%`);
      el.classList.add('tilt');
    });
  });
  el.addEventListener('pointerleave', () => { cancelAnimationFrame(raf); el.style.transform = ''; el.classList.remove('tilt'); });
}

/** Stat rows for a card: STR / AGI / RES / INT as meters. */
export function statRows(card: Card): HTMLElement {
  const max = 52000;
  const box = h('div', { class: 'stats' });
  for (const [k, label] of [['str', 'Strength'], ['agi', 'Agility'], ['res', 'Resolve'], ['int', 'Intellect']] as const) {
    const m = h('div', { class: 'meter', style: `--accent:${ELEMENT_COLOR[card.element]}` }, h('i', { style: `--v:${Math.round((card.stats[k] / max) * 100)}%` }));
    box.append(h('div', { class: 'stat' }, h('span', { class: 'k', text: label }), m, h('span', { class: 'v tabnum', text: card.stats[k].toLocaleString() })));
  }
  return box;
}
