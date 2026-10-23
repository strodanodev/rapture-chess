/** The champion card: art in a frame coloured by Kind (rarity), an element gem, the name plate, and a foil that follows the pointer. */
import type { Card } from '../roster';
import { ELEMENT_COLOR, PIECE_NAME } from '../roster';
import type { PieceType } from '../rules/chessRules';
import { h, icon, toast } from './dom';

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

/** Who the champion is: rarity, element, faction, and its Path, Alignment and Frame from the token. */
export function identityTags(card: Card, opts: { compact?: boolean } = {}): HTMLElement {
  const l = card.lore;
  return h('div', { class: 'id-tags' },
    h('span', { class: 'badge rarity', data: { kind: card.kind }, text: RARITY[card.kind] }),
    h('span', { class: 'badge outline el', style: `--dotc:${ELEMENT_COLOR[card.element]}`, text: card.element }),
    h('span', { class: 'badge outline', text: card.faction }),
    l?.path ? h('span', { class: 'badge outline', text: l.path }) : null,
    l?.alignment ? h('span', { class: 'badge outline', text: l.alignment }) : null,
    !opts.compact && l?.frame ? h('span', { class: 'badge outline', title: 'Frame', text: `${l.frame} frame` }) : null);
}

/**
 * The champion's lore, from the soul file its token pins: its own words (or what it holds to) as the quote, then, in
 * full, its values, voice, temper, how it fights and where it breaks. Compact shows the quote alone.
 */
export function loreBlock(card: Card, opts: { compact?: boolean } = {}): HTMLElement {
  const l = card.lore;
  // the bio opens with the epithet, which the card already shows
  const bio = l?.bio?.startsWith(`${card.epithet}.`) ? l.bio.slice(card.epithet.length + 1).trim() : l?.bio;
  const story = l?.story ?? null;
  // the quote: the champion's own words; else (compact) the story's opening, else what it holds to, else the bio
  const quote = sentence(l?.quote ?? (opts.compact && story ? firstSentence(story) : null) ?? (story ? null : l?.values ?? bio) ?? card.epithet);
  const line = (k: string, v: string | null | undefined) => (v && sentence(v) !== quote ? h('p', { class: 'lore-line' }, h('span', { class: 'k', text: k }), sentence(v)) : null);
  return h('div', { class: `lore${opts.compact ? ' compact' : ''}` },
    opts.compact || l?.quote || !story ? h('blockquote', { class: 'lore-quote', text: quote }) : null,
    ...(opts.compact ? [] : [
      story ? h('p', { class: 'lore-story', text: story }) : null,
      line('Values', l?.values), line('Voice', l?.voice), line('Temperament', l?.temperament), line('In battle', l?.battle), line('Weakness', l?.weakness),
    ]));
}
const firstSentence = (s: string): string => /^.*?[.!?](?=\s|$)/.exec(s)?.[0] ?? s;
/** Soul notes read as fragments ("completion over glory. He…"): capitalise the first letter. */
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const shortHash = (hex: string): string => `${hex.slice(0, 8)}…${hex.slice(-6)}`;
const copy = (value: string) => (): void => {
  void navigator.clipboard?.writeText(value).then(() => toast('Copied'), () => toast('Could not copy', 'err'));
};

/** Provenance: the token id and the content hashes it pins on chain (tap a hash to copy it). */
export function provenance(card: Card, opts: { compact?: boolean } = {}): HTMLElement {
  const l = card.lore;
  const rows: Array<{ k: string; v: string; ok?: boolean }> = [{ k: 'Token', v: card.tokenId }];
  if (l?.soulHash) rows.push({ k: 'Soul', v: l.soulHash, ok: l.soulVerified });
  if (!opts.compact && l?.designHash) rows.push({ k: 'Design', v: l.designHash });
  if (!opts.compact && l?.avatarHash) rows.push({ k: 'Avatar', v: l.avatarHash });
  return h('dl', { class: 'prov' }, ...rows.flatMap(({ k, v, ok }) => [
    h('dt', { text: k }),
    h('dd', { class: 'hash tabnum', title: ok ? `${v} (matches the hash the token pins)` : v, on: { click: copy(v) } },
      h('span', { text: v.startsWith('0x') ? shortHash(v) : `#${v}` }), ok ? icon('check') : null),
  ]));
}
