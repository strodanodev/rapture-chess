/** Leaderboards: the LitNode ladder (folded from MatchBook's finalized results by any node) and the local practice record. */
import { readLadder, type Ladder, type LadderLine } from '../../litnode/ladder';
import type { App } from '../app';
import { h, icon } from '../dom';
import { DIFFICULTY, record, type Difficulty } from '../prefs';
import { pageHead, type Screen } from '../router';

const short = (k: string): string => (k.length > 16 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k);
const host = (u: string): string => { try { return new URL(u).host; } catch { return u; } };

export function ranksScreen(app: App): Screen {
  let tab: 'mesh' | 'practice' = 'mesh';
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div', { class: 'ranks-body' });

  const renderTabs = () => tabs.replaceChildren(
    h('button', { class: tab === 'mesh' ? 'on' : '', role: 'tab', text: 'Mesh ladder', on: { click: () => { tab = 'mesh'; draw(); } } }),
    h('button', { class: tab === 'practice' ? 'on' : '', role: 'tab', text: 'Practice', on: { click: () => { tab = 'practice'; draw(); } } }));

  const podium = (top: LadderLine[]) => h('div', { class: 'podium' }, ...[1, 0, 2].map((i) => top[i]).filter(Boolean).map((l) =>
    h('div', { class: `pod pod-${l.rank}` },
      h('span', { class: 'pod-medal' }, icon(l.rank === 1 ? 'crown' : 'trophy')),
      h('span', { class: 'pod-name tabnum', text: short(l.player) }),
      h('span', { class: 'pod-lvl', text: `Level ${l.level}` }),
      h('span', { class: 'pod-rec tabnum', text: `${l.wins}W ${l.losses}L ${l.draws}D` }),
      h('div', { class: 'pod-base', text: String(l.rank) }))));

  const table = (rows: LadderLine[]) => h('div', { class: 'ladder', role: 'table' },
    h('div', { class: 'lrow head', role: 'row' }, ...['#', 'Player', 'Level', 'Rating', 'Record', 'Streak'].map((t) => h('span', { role: 'columnheader', text: t }))),
    ...rows.map((l) => h('div', { class: `lrow r${Math.min(l.rank, 4)}`, role: 'row' },
      h('span', { class: 'rank tabnum', text: String(l.rank) }),
      h('span', { class: 'who tabnum', title: l.player, text: short(l.player) }),
      h('span', { class: 'lvl' }, h('b', { text: String(l.level) }), h('i', { class: 'meter' }, h('i', { style: `--v:${Math.min(100, Math.round((l.xp / Math.max(1, l.xp + 80)) * 100))}%` }))),
      h('span', { class: 'tabnum', text: String(Math.round(l.rating)) }),
      h('span', { class: 'tabnum', text: `${l.wins}-${l.losses}-${l.draws}` }),
      h('span', { class: 'tabnum', text: l.streak ? String(l.streak) : '·' }))));

  async function mesh(): Promise<void> {
    body.replaceChildren(h('div', { class: 'loading-block' }, h('span', { class: 'spinner' }), h('span', { text: 'Asking the LitNode mesh…' })));
    let lad: Ladder;
    try { lad = await readLadder(app.nodeHint()); } catch (e) {
      body.replaceChildren(h('div', { class: 'empty-state' }, icon('globe'), h('h3', { class: 'display', text: 'The mesh is quiet' }), h('p', { text: (e as Error).message }),
        h('button', { class: 'btn sm', on: { click: () => void mesh() } }, icon('refresh'), 'Try again')));
      return;
    }
    if (tab !== 'mesh') return;
    const src = h('div', { class: 'ladder-src' },
      h('span', { class: 'chip' }, icon('globe'), host(lad.node)),
      h('span', { class: 'chip' }, icon('shield'), lad.source === 'chain' ? 'Folded from MatchBook (on chain)' : 'This node\'s results'),
      h('span', { class: 'chip tabnum' }, icon('check'), `${lad.finalized} final · ${lad.pending} pending`));
    if (!lad.ranking.length) {
      body.replaceChildren(src, h('div', { class: 'empty-state' }, icon('trophy'),
        h('h3', { class: 'display', text: 'The ladder awaits its first champion' }),
        h('p', { text: 'Ranked Rapture Chess matches are placed by the LitNode mesh from the LitVM arcade. The first finalized result opens the ladder: every node will show the same table.' }),
        h('button', { class: 'btn primary', on: { click: () => app.openRanked() } }, icon('swords'), 'Play ranked')));
      return;
    }
    body.replaceChildren(src, lad.ranking.length >= 3 ? podium(lad.ranking.slice(0, 3)) : h('span'), table(lad.ranking));
  }

  function practice(): void {
    const r = record();
    const total = r.wins + r.losses + r.draws;
    const big = (n: number | string, label: string, cls = '') => h('div', { class: `bigstat ${cls}` }, h('b', { class: 'tabnum', text: String(n) }), h('span', { text: label }));
    const by = (Object.keys(DIFFICULTY) as Difficulty[]).map((d) => {
      const x = r.by[d], n = x.wins + x.losses + x.draws;
      return h('div', { class: 'odd', style: '--accent:var(--gold-2)' }, h('span', { class: 'k', text: DIFFICULTY[d].name }),
        h('div', { class: 'meter' }, h('i', { style: `--v:${n ? Math.round((x.wins / n) * 100) : 0}%` })), h('span', { class: 'v tabnum', text: `${x.wins}/${n}` }));
    });
    const hist = r.history.length ? h('div', { class: 'history' }, ...r.history.map((g) => h('div', { class: `hrow ${g.result}` },
      h('span', { class: 'res', text: g.result === 'win' ? 'Victory' : g.result === 'loss' ? 'Defeat' : 'Draw' }),
      h('span', { text: `${g.side === 0 ? 'Alliance' : 'Horde'} vs ${DIFFICULTY[g.difficulty].name}` }),
      h('span', { class: 'tabnum', text: `${g.moves} moves` }),
      h('span', { class: 'tabnum dim', text: new Date(g.at).toLocaleDateString() }))))
      : h('p', { class: 'hint', text: 'Your games against the Oracle are kept on this device.' });
    body.replaceChildren(
      h('div', { class: 'bigstats' }, big(r.wins, 'Victories', 'win'), big(r.losses, 'Defeats', 'loss'), big(r.draws, 'Draws'), big(total ? `${Math.round((r.wins / total) * 100)}%` : '·', 'Win rate'), big(r.best, 'Best streak')),
      h('div', { class: 'panel soft' }, h('div', { class: 'panel-body' }, h('span', { class: 'eyebrow', text: 'Win rate by Oracle strength' }), ...by)),
      hist);
  }

  const draw = () => { renderTabs(); if (tab === 'mesh') void mesh(); else practice(); };
  const el = h('section', { class: 'page ranks' }, pageHead('Leaderboards', 'Rapture Chess · Season 0'), h('div', { class: 'page-body' }, tabs, body));
  return { id: 'ranks', el, opaque: true, enter() { draw(); } };
}
