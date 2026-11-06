/**
 * The Ranked panel. On the game's own page it queues on the LitNode mesh with the game's own player key
 * (src/litnode/standalone.ts) and hands the placed match to the board. Inside the arcade's frame the arcade owns the key
 * and the queue, so the panel points there instead.
 */
import type { ChainClient } from 'tessaract/web/lib/chain.js';
import { canHoldKey, findRanked, playerKey, type RankedPlacement } from '../litnode/standalone';
import { ARCADE_URL } from './app';
import { h, icon, modal } from './dom';

export interface RankedDeps {
  chain: ChainClient;
  /** This page runs inside the arcade's frame. */
  inArcade: boolean;
  openStakes(): void;
  /** Seat the player in the placed match. */
  play(p: RankedPlacement): void;
}

const short = (k: string): string => (k.length > 14 ? `${k.slice(0, 8)}…${k.slice(-6)}` : k);

export function openRanked(d: RankedDeps): void {
  if (d.inArcade || !canHoldKey()) return arcadePanel(d);
  let search: AbortController | null = null;
  let seated = false;
  const status = h('p', { class: 'mm-status', role: 'status', aria: { live: 'polite' } });
  const keyLine = h('p', { class: 'note', text: 'Loading your LitNode key…' });
  const find = h('button', { class: 'btn primary' }, icon('swords'), 'Find a ranked match');
  const stop = h('button', { class: 'btn', hidden: true }, icon('close'), 'Stop');
  const stakes = h('button', { class: 'btn' }, icon('stake'), 'Stakes');
  const say = (text: string, err = false): void => { status.textContent = text; status.classList.toggle('err', err); };
  const searching = (on: boolean): void => { find.hidden = on; stop.hidden = !on; stakes.disabled = on; status.classList.toggle('busy', on); };

  find.onclick = async () => {
    search = new AbortController();
    searching(true);
    say('Starting…');
    try {
      const p = await findRanked({ chain: d.chain, signal: search.signal, say: (t) => say(t) });
      if (!p) { say(search.signal.aborted ? 'Stopped.' : 'Nobody queued in five minutes. Try again, or ask a friend to press Find at the same time.'); return; }
      seated = true;
      m.close();
      d.play(p);
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      search = null;
      if (!seated) searching(false);
    }
  };
  stop.onclick = () => search?.abort();
  stakes.onclick = () => { m.close(); d.openStakes(); };
  void playerKey().then((k) => { keyLine.textContent = `You play as LitNode key ${short(k.publicKey)}, kept in this browser. Stakes bind to it.`; },
    (e: Error) => { keyLine.textContent = `This browser cannot hold a LitNode key: ${e.message}`; find.disabled = true; });

  const body = h('div', { class: 'ranked-info' },
    h('p', { class: 'lede', text: 'Ranked Rapture Chess runs on the LitNode mesh: a bonded node places the match, hosts it, replays every move and signs the result.' }),
    h('ol', { class: 'steps' },
      h('li', null, h('b', { text: 'Stake (optional).' }), ' Put zkLTC behind your key. The winner takes twice the smaller stake; a draw moves nothing.'),
      h('li', null, h('b', { text: 'Find a match.' }), ' The mesh pairs you with the next player who queues, from here or from the arcade.'),
      h('li', null, h('b', { text: 'Stay to the end.' }), ' Both players sign the result as the game ends; then the winner claims from Stakes.')),
    keyLine,
    h('div', { class: 'row-actions' }, find, stop, stakes),
    status,
    h('p', { class: 'note' }, 'Prefer the arcade? ', h('a', { href: ARCADE_URL, target: '_blank', rel: 'noopener', text: 'arcade.litvm.games' }), ' queues under its own key.'));
  const m = modal('Ranked on LitNode', body, { onClose: () => { if (!seated) search?.abort(); } });
}

/** Inside the arcade (or a browser with no Ed25519): the arcade's Find match is the way in. */
function arcadePanel(d: RankedDeps): void {
  const body = h('div', { class: 'ranked-info' },
    h('p', { class: 'lede', text: 'Ranked Rapture Chess runs on the LitNode mesh. In the arcade, queue with its Find match: a bonded node places the match, hosts it, replays every move and signs the result.' }),
    h('ol', { class: 'steps' },
      h('li', null, h('b', { text: 'Stake (optional).' }), ' Put zkLTC behind your arcade player key. The winner takes twice the smaller stake; a draw moves nothing.'),
      h('li', null, h('b', { text: 'Find match in the arcade.' }), ' Pick Rapture Chess; the mesh pairs you and opens this table.'),
      h('li', null, h('b', { text: 'Claim.' }), ' When the node has settled, claim the pot here with its signed result.')),
    h('div', { class: 'row-actions' },
      d.inArcade ? null : h('a', { class: 'btn primary', href: ARCADE_URL, target: '_blank', rel: 'noopener' }, icon('external'), 'Open the arcade'),
      h('button', { class: 'btn', on: { click: () => { m.close(); d.openStakes(); } } }, icon('stake'), 'Stakes')));
  const m = modal('Ranked on LitNode', body);
}
