/** The match loading screen: the two banners crash together with their god-kings, while the armies load. */
import type { Card } from '../../roster';
import { ART } from '../cardview';
import { h, icon } from '../dom';
import type { Screen } from '../router';
import { crest } from '../widgets';
import { gvtMark } from '../brand';

const TIPS = [
  'Held champions take the field first: open packs in the Shop to field your own.',
  'Gods sit on the thrones, Titans in the towers, Kings and Demigods at their sides, Mortals on the line.',
  'Ranked results are replayed and signed by LitNode nodes, then finalized on MatchBook.',
  'A stake pays twice the smaller stake to the winner; a draw moves nothing.',
  'Press Esc for the battle menu; F flips the view.',
  'Tap a champion to see its card; tap a glowing square to move.',
];

export interface VersusInfo { you: 0 | 1; names: [string, string]; subs: [string, string]; gods: [Card | null, Card | null]; realm: string }

export function versusScreen(): Screen & { show(info: VersusInfo): void; progress(p: number, text: string): void } {
  const side = (s: 0 | 1) => {
    const art = h('img', { class: 'vs-art', alt: '', decoding: 'async' });
    const name = h('span', { class: 'vs-name display' });
    const sub = h('span', { class: 'vs-sub' });
    const el = h('div', { class: `vs-side ${s === 0 ? 'alliance' : 'horde'}` }, art, h('div', { class: 'vs-id' }, crest(s, 'lg'), h('span', { class: 'vs-faction', text: s === 0 ? 'Alliance' : 'Horde' }), name, sub));
    return { el, art, name, sub };
  };
  const a = side(0), b = side(1);
  const bar = h('i');
  const label = h('span', { class: 'vs-status' });
  const tip = h('p', { class: 'vs-tip' });
  const realm = h('span', { class: 'eyebrow' });
  const el = h('section', { class: 'versus', aria: { label: 'Loading the match', busy: 'true' } },
    a.el, b.el,
    h('div', { class: 'vs-mark' }, h('div', { class: 'vs-flash' }), h('span', { class: 'gilded', text: 'VS' })),
    h('div', { class: 'vs-foot' }, gvtMark('vs-gvt'), realm, h('div', { class: 'vs-bar' }, bar), label, tip, h('span', { class: 'vs-rune' }, icon('rune'))));

  return {
    id: 'versus', el, opaque: true,
    show(info) {
      for (const [i, s] of [a, b].entries()) {
        const g = info.gods[i];
        s.art.hidden = !g;
        if (g) { s.art.src = ART(g.slug); s.art.alt = g.name; }
        s.name.textContent = info.names[i];
        s.sub.textContent = info.subs[i];
      }
      el.dataset.you = String(info.you);
      realm.textContent = `Battlefield · ${info.realm}`;
      tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
      bar.style.transform = 'scaleX(0)';
      el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
    },
    progress(p, text) { bar.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`; label.textContent = text; },
  };
}
