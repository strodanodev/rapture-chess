/** The Armory: all fifty champions, filterable, with the wallet's own marked; a card opens its full sheet. */
import type { Card } from '../../roster';
import { ELEMENT_COLOR, power } from '../../roster';
import type { App } from '../app';
import { championCard, identityTags, loreBlock, provenance, ROLE_OF } from '../cardview';
import { h, icon, modal } from '../dom';
import { go, pageHead, type Screen } from '../router';
import { walletChip } from '../widgets';

type Filter = { faction: string; kind: string; element: string; held: boolean };
const KINDS: Card['kind'][] = ['God', 'Titan', 'King', 'Demigod', 'Mortal'];
const ELEMENTS: Card['element'][] = ['Water', 'Earth', 'Lava', 'Metal'];

export function armoryScreen(app: App): Screen {
  const f: Filter = { faction: 'all', kind: 'all', element: 'all', held: false };
  const grid = h('div', { class: 'card-grid' });
  const count = h('span', { class: 'count tabnum' });
  const bar = h('div', { class: 'filters' });

  const chipRow = (label: string, key: 'faction' | 'kind' | 'element', values: string[]) =>
    h('div', { class: 'chip-row', role: 'group', aria: { label } }, ...['all', ...values].map((v) => h('button', {
      class: `chip${f[key] === v ? ' on' : ''}`, text: v === 'all' ? `All ${label.toLowerCase()}` : v,
      style: key === 'element' && v !== 'all' ? `--dotc:${ELEMENT_COLOR[v as Card['element']]}` : undefined,
      on: { click: () => { f[key] = v; render(); } },
    })));

  const open = (c: Card) => {
    const owned = app.web3.owned.has(c.tokenId);
    const sheet = h('div', { class: 'sheet' },
      h('div', { class: 'sheet-card' }, championCard(c, { owned, eager: true, tilt: true })),
      h('div', { class: 'sheet-info' },
        identityTags(c),
        h('p', { class: 'epithet', text: c.epithet }),
        h('p', { class: 'kicker', text: `${c.kind} · fights as ${ROLE_OF[c.kind]}` }),
        loreBlock(c),
        provenance(c),
        owned ? h('p', { class: 'hint ok' }, icon('check'), 'In your wallet: seated first in every army you field.')
          : h('button', { class: 'btn sm', on: { click: () => { m.close(); void go('shop'); } } }, icon('bag'), 'Find it in a pack')));
    const m = modal(c.name, sheet, { wide: true });
  };

  const render = () => {
    bar.replaceChildren(
      chipRow('Factions', 'faction', ['Alliance', 'Horde']),
      chipRow('Kinds', 'kind', KINDS),
      chipRow('Elements', 'element', ELEMENTS),
      h('div', { class: 'chip-row' }, h('button', { class: `chip${f.held ? ' on' : ''}`, on: { click: () => { f.held = !f.held; render(); } } }, icon('wallet'), 'Held only'), count));
    const list = app.snapshot.cards
      .filter((c) => (f.faction === 'all' || c.faction === f.faction) && (f.kind === 'all' || c.kind === f.kind) && (f.element === 'all' || c.element === f.element) && (!f.held || app.web3.owned.has(c.tokenId)))
      .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || power(b) - power(a));
    count.textContent = `${list.length} of ${app.snapshot.cards.length} · ${app.web3.owned.size} held`;
    grid.replaceChildren(...list.map((c, i) => {
      const card = championCard(c, { owned: app.web3.owned.has(c.tokenId), button: true });
      card.style.setProperty('--i', String(Math.min(i, 24)));
      card.addEventListener('click', () => open(c));
      return card;
    }));
    if (!list.length) grid.append(h('p', { class: 'empty', text: f.held ? 'No held champions match. Connect a wallet or open a pack in the Shop.' : 'No champion matches these filters.' }));
  };
  app.web3.onChange(() => { if (!el.hidden) render(); });

  const el = h('section', { class: 'page armory' }, pageHead('Armory', 'Rapture ARC 1 · 50 champions', walletChip(app)), h('div', { class: 'page-body' }, bar, grid));
  return { id: 'armory', el, opaque: true, enter() { render(); } };
}
