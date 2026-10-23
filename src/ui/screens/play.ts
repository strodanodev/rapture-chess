/** Skirmish setup: pick a banner, the Oracle's strength and the battlefield; the arena behind previews each choice. */
import type { Side } from '../../rules/chessRules';
import { REALM_NAME } from '../../scene/realm';
import type { App } from '../app';
import { h, icon, stagger } from '../dom';
import { DIFFICULTY, prefs, record, setPref, type Difficulty, type RealmChoice } from '../prefs';
import { pageHead, type Screen } from '../router';
import { crest, walletChip } from '../widgets';

export function playScreen(app: App): Screen {
  const banner = (side: Side) => {
    const name = side === 0 ? 'Alliance' : 'Horde';
    const b = h('button', { class: `banner-pick ${side === 0 ? 'alliance' : 'horde'}`, aria: { pressed: 'false' }, on: { click: () => pickSide(side) } },
      crest(side, 'lg'),
      h('span', { class: 'bp-name display', text: name }),
      h('span', { class: 'bp-sub', text: side === 0 ? 'Ivory · Valhalla · moves first' : 'Obsidian · Underworld · answers' }));
    return b;
  };
  const banners = [banner(0), banner(1)];
  const diffSeg = h('div', { class: 'seg' });
  const diffBlurb = h('p', { class: 'hint' });
  const realmSeg = h('div', { class: 'seg' });
  const rec = h('p', { class: 'hint tabnum' });

  const pickSide = (s: Side) => { setPref('side', s); render(); preview(); };
  const pickDiff = (d: Difficulty) => { setPref('difficulty', d); render(); };
  const pickRealm = (r: RealmChoice) => { setPref('realm', r); render(); preview(); };
  const preview = () => app.preview(app.realmFor(prefs.realm, prefs.side), prefs.side);

  const render = () => {
    banners.forEach((b, i) => { b.classList.toggle('on', prefs.side === i); b.setAttribute('aria-pressed', String(prefs.side === i)); });
    diffSeg.replaceChildren(...(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => h('button', { class: prefs.difficulty === d ? 'on' : '', text: DIFFICULTY[d].name, on: { click: () => pickDiff(d) } })));
    diffBlurb.textContent = DIFFICULTY[prefs.difficulty].blurb;
    const realms: Array<[RealmChoice, string]> = [['auto', 'By banner'], ['valhalla', REALM_NAME.valhalla], ['underworld', REALM_NAME.underworld]];
    realmSeg.replaceChildren(...realms.map(([r, label]) => h('button', { class: `realm-${r}${prefs.realm === r ? ' on' : ''}`, on: { click: () => pickRealm(r) } }, h('i', { class: 'swatch' }), label)));
    const r = record();
    rec.textContent = r.wins + r.losses + r.draws ? `Your record against the Oracle: ${r.wins} wins, ${r.losses} losses, ${r.draws} draws · best streak ${r.best}` : 'Your first duel against the Oracle awaits.';
  };

  const start = h('button', { class: 'btn primary lg block pulse', on: { click: () => app.startSkirmish(prefs.side, prefs.difficulty, prefs.realm) } }, icon('swords'), 'Enter the arena');
  const body = h('div', { class: 'play-panel panel frame' },
    h('div', { class: 'panel-head' }, h('h2', { text: 'Skirmish' }), h('span', { class: 'badge outline', text: 'vs the Oracle' })),
    stagger(h('div', { class: 'panel-body play-body' },
      h('div', { class: 'field' }, h('span', { text: 'Choose your banner' }), h('div', { class: 'banners' }, ...banners)),
      h('div', { class: 'field' }, h('span', { text: 'Oracle strength' }), diffSeg, diffBlurb),
      h('div', { class: 'field' }, h('span', { text: 'Battlefield' }), realmSeg),
      start,
      rec,
      h('div', { class: 'ornament' }, icon('rune')),
      h('button', { class: 'link-btn', on: { click: () => app.openRanked() } }, icon('swords'), 'Ranked and staked matches run on LitNode')), 120));

  const el = h('section', { class: 'page play' }, h('div', { class: 'play-scrim' }), pageHead('Play', 'Choose your war', walletChip(app)), h('div', { class: 'play-wrap' }, body));
  return { id: 'play', el, enter() { render(); preview(); } };
}
