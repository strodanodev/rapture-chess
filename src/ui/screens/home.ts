/** The main menu over the live 3D arena: logo, the menu, a featured champion, and the wallet. */
import type { Card } from '../../roster';
import type { App } from '../app';
import { championCard, ROLE_OF } from '../cardview';
import { embers, h, icon, stagger } from '../dom';
import type { IconName } from '../icons';
import { record } from '../prefs';
import { go, type Screen } from '../router';
import { emblem, gvtMark, titleArt } from '../brand';
import { walletChip } from '../widgets';

export function homeScreen(app: App): Screen & { setMate(name: string, where: string, san: string): void } {
  const menuItem = (ico: IconName, title: string, sub: () => string, onClick: () => void) => {
    const s = h('span', { class: 's' });
    const b = h('button', { class: 'menu-item', on: { click: onClick } },
      h('span', { class: 'mi-ico' }, icon(ico)), h('span', { class: 'mi-text' }, h('span', { class: 't', text: title }), s), h('span', { class: 'mi-arrow' }, icon('back')));
    return { b, refresh: () => { s.textContent = sub(); } };
  };
  const items = [
    menuItem('swords', 'Ranked', () => 'LitNode mesh · zkLTC stakes', () => app.openRanked()),
    menuItem('grid', 'Armory', () => `${app.snapshot.cards.length} champions · ${app.web3.owned.size} held`, () => void go('armory')),
    menuItem('bag', 'Shop', () => 'Rapture ARC 1 packs', () => void go('shop')),
    menuItem('trophy', 'Leaderboards', () => { const r = record(); return `Practice ${r.wins}W ${r.losses}L ${r.draws}D`; }, () => void go('ranks')),
    menuItem('gear', 'Settings', () => 'Graphics, motion, wallet', () => void go('settings')),
  ];
  const play = h('button', { class: 'btn primary lg pulse play-btn', on: { click: () => void go('play') } }, icon('play'), 'Play');
  const menu = stagger(h('nav', { class: 'home-menu', aria: { label: 'Main menu' } }, play, ...items.map((i) => i.b)), 260);

  // featured champion: cycles through the gods (held ones first)
  const featureSlot = h('div', { class: 'feature-card' });
  const featureCap = h('div', { class: 'feature-cap' });
  const feature = h('aside', { class: 'home-feature' }, h('span', { class: 'eyebrow', text: 'Featured champion' }), featureSlot, featureCap);
  let fi = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const pool = (): Card[] => {
    const gods = app.snapshot.cards.filter((c) => c.kind === 'God' || c.kind === 'Titan');
    return [...gods.filter((c) => app.web3.owned.has(c.tokenId)), ...gods.filter((c) => !app.web3.owned.has(c.tokenId))];
  };
  const showFeature = () => {
    const list = pool();
    const c = list[fi++ % list.length];
    const card = championCard(c, { owned: app.web3.owned.has(c.tokenId), eager: true, tilt: true });
    card.classList.add('swap-in');
    featureSlot.replaceChildren(card);
    featureCap.replaceChildren(h('p', { class: 'epithet', text: c.epithet }), h('p', { class: 'kicker', text: `${c.element} · ${ROLE_OF[c.kind]}` }));
  };

  const logo = h('div', { class: 'logo' },
    h('div', { class: 'logo-emblem' }, emblem(), h('div', { class: 'logo-ring' })),
    h('p', { class: 'kicker', text: 'LitVM Games presents' }),
    h('h1', { class: 'logo-word' }, titleArt()),
    h('p', { class: 'tagline', text: 'Fifty champions of Rapture ARC 1. One board. Settled on LitNode.' }));

  // the plaque naming the checkmate re-enacted on the board behind the menu
  const mateName = h('b', { class: 'display' });
  const mateWhere = h('span');
  const mateSan = h('span', { class: 'mp-san tabnum' });
  const plaque = h('div', { class: 'mate-plaque', aria: { live: 'polite' } }, h('span', { class: 'eyebrow', text: 'On the board' }), mateName, mateWhere, mateSan);

  const el = h('section', { class: 'home', aria: { label: 'Main menu' } },
    h('div', { class: 'home-scrim' }),
    embers(18, ['#ffc95e', '#ff7438', '#ffe2a0']),
    h('header', { class: 'home-top' }, h('div', { class: 'home-brand' }, gvtMark(), h('span', { class: 'badge outline live', text: 'Season 0 · Liteforge' })), walletChip(app)),
    h('div', { class: 'home-main' }, logo, plaque, menu),
    feature,
    h('footer', { class: 'home-foot' }, h('span', { text: 'Built with Deckwright · three.js · LitNode' })));

  app.web3.onChange(() => { for (const i of items) i.refresh(); });
  return {
    id: 'home', el,
    setMate(name, where, san) {
      mateName.textContent = name; mateWhere.textContent = where; mateSan.textContent = san;
      plaque.classList.remove('swap'); void plaque.offsetWidth; plaque.classList.add('swap');
    },
    enter() {
      for (const i of items) i.refresh();
      stagger(menu, 260);
      if (!timer) { showFeature(); timer = setInterval(showFeature, 7000); }
    },
    leave() { if (timer) clearInterval(timer); timer = null; },
  };
}
