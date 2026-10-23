/**
 * The wager panel: open a zkLTC wager (escrow `createMatch`), share the join link, join one (`joinMatch` with the
 * same stake), play over the relay, then submit the relay-signed settlement (`settle`). Every transaction goes
 * through the Deckwright wallet; every dynamic string goes through textContent.
 *
 * Wiring (main.ts):
 *   const wager = mountWager({ root, web3, onStartRelayMatch: (o) => startRelay(o) });
 *   relayMatch.onSettlement((s) => wager.showSettlement(s)); relayMatch.onClock((c) => wager.showClock(c));
 */
import './wager.css';
import { createChain, type ChainClient } from 'deckwright/web/lib/chain.js';
import type { Web3Link } from '../web3/wallet';
import type { Side } from '../rules/chessRules';
import type { RelayClock, RelaySettlement } from '../game/relay';
import {
  MatchStatus, STATUS_NAME, encodeCancel, encodeCreateMatch, encodeJoinMatch, encodeSettle, encodeTimeoutClaim, encodeWithdraw,
  formatZkLtc, matchIdOf, parseZkLtc, randomSeed, readMatch, readPending, seedCommitOf, isBytes32,
} from '../web3/wager';

export interface RelayStart { url: string; matchId: string; side: Side; stakeWei: bigint; seed?: string }
export interface WagerMountOptions {
  root: HTMLElement;
  web3: Web3Link;
  onStartRelayMatch(opts: RelayStart): void;
  /** Overrides for the build-time defaults. */
  relayUrl?: string;
  contract?: string;
  rpc?: string;
}
export interface WagerPanel {
  readonly element: HTMLElement;
  showSettlement(s: RelaySettlement): void;
  showClock(c: RelayClock): void;
  /** Hide or show the whole panel (the title screen vs the game). */
  setVisible(on: boolean): void;
}

const STORE = 'rapture-chess.wager.v1';
const env = import.meta.env as Record<string, string | undefined>;
const el = (tag: string, cls = '', text = ''): HTMLElement => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const button = (text: string, cls = ''): HTMLButtonElement => { const b = document.createElement('button'); b.textContent = text; if (cls) b.className = cls; return b; };
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface Saved { matchId: string; seed: string; stakeWei: string; relay: string; side: Side }

export function mountWager(o: WagerMountOptions): WagerPanel {
  const relayUrl = o.relayUrl ?? env.VITE_RELAY_URL ?? 'ws://127.0.0.1:7831';
  const contract = o.contract ?? env.VITE_WAGER_ADDRESS ?? '';
  const rpc = o.rpc ?? env.VITE_RPC_URL ?? 'https://liteforge.rpc.caldera.xyz/http';
  const chain: ChainClient = createChain(rpc);
  const wallet = o.web3.wallet;
  const configured = /^0x[0-9a-fA-F]{40}$/.test(contract);

  const box = el('section', 'wager');
  box.setAttribute('aria-label', 'zkLTC wager');
  const title = el('h3', '', 'zkLTC wager');
  const note = el('p', 'note');
  const body = el('div');
  box.append(title, note, body);
  o.root.append(box);

  let current: Saved | null = recall();
  let settlement: RelaySettlement | null = null;
  const link = new URL(location.href);
  const joinId = link.searchParams.get('match');
  const joinStake = link.searchParams.get('stake');
  const joinRelay = link.searchParams.get('relay') ?? relayUrl;

  const say = (text: string, err = false): void => { note.textContent = text; note.classList.toggle('err', err); };
  const needWallet = (): string | null => {
    const a = wallet.snapshot().address;
    if (!a) { say('Connect your wallet first.', true); return null; }
    return a;
  };
  async function send(data: string, value?: bigint): Promise<string> {
    await wallet.ensureChain();
    const hash = await wallet.sendTransaction({ to: contract, data, value });
    say(`Sent ${short(hash)}, waiting for the chain…`);
    const rc = await chain.waitForReceipt(hash);
    if (Number(rc.status) !== 1) throw new Error('the transaction reverted');
    return hash;
  }

  // ------------------------------------------------------------------ views
  function render(): void {
    body.replaceChildren();
    if (!configured) { say('No escrow is configured for this build (VITE_WAGER_ADDRESS). Wagers are off; friendly relay matches still work.', true); renderFriendly(); return; }
    if (settlement) return renderSettlement();
    if (joinId && isBytes32(joinId) && (!current || current.matchId !== joinId)) return renderJoin(joinId, joinStake, joinRelay);
    if (current) return renderOpen(current);
    renderCreate();
  }

  function renderCreate(): void {
    say('Stake zkLTC against an opponent. The winner takes both stakes; a draw refunds both. Settled by the relay\'s signed result, with a 50/50 timeout fallback.');
    const stake = document.createElement('input');
    stake.type = 'text'; stake.inputMode = 'decimal'; stake.placeholder = '0.1'; stake.value = '0.1'; stake.setAttribute('aria-label', 'stake in zkLTC');
    const relay = document.createElement('input');
    relay.type = 'url'; relay.value = relayUrl; relay.setAttribute('aria-label', 'relay url');
    const go = button('Create wager', 'primary');
    const row1 = el('div', 'row'); row1.append(el('label', '', 'Stake'), stake, el('span', '', 'zkLTC'));
    const row2 = el('div', 'row'); row2.append(el('label', '', 'Relay'), relay);
    body.append(row1, row2, go);
    go.onclick = async () => {
      const address = needWallet();
      if (!address) return;
      let wei: bigint;
      try { wei = parseZkLtc(stake.value); if (wei <= 0n) throw new Error('stake must be above zero'); } catch (e) { return say((e as Error).message, true); }
      go.disabled = true;
      try {
        const seed = randomSeed();
        const matchId = matchIdOf(seed);
        await send(encodeCreateMatch(matchId, seedCommitOf(seed)), wei);
        current = { matchId, seed, stakeWei: wei.toString(), relay: relay.value.trim() || relayUrl, side: 0 };
        remember(current);
        say('Wager open. Send the link to your opponent; the board starts when both of you are seated.');
        render();
        o.onStartRelayMatch({ url: current.relay, matchId, side: 0, stakeWei: wei, seed });
      } catch (e) { say((e as Error).message, true); go.disabled = false; }
    };
  }

  function renderOpen(s: Saved): void {
    const url = new URL(location.origin + location.pathname);
    url.searchParams.set('match', s.matchId); url.searchParams.set('stake', s.stakeWei); url.searchParams.set('relay', s.relay);
    const pill = el('span', 'pill', s.side === 0 ? 'Alliance · creator' : 'Horde · joiner');
    const stake = el('p', 'note', `Stake ${formatZkLtc(BigInt(s.stakeWei))} zkLTC each · match ${short(s.matchId)}`);
    const linkBox = el('div', 'link', url.toString());
    const copy = button('Copy link');
    const resume = button('Rejoin board');
    const cancel = button('Cancel (unjoined)');
    const timeout = button('Timeout claim');
    const forget = button('Forget');
    copy.onclick = () => { void navigator.clipboard?.writeText(url.toString()).then(() => say('Link copied.')); };
    resume.onclick = () => o.onStartRelayMatch({ url: s.relay, matchId: s.matchId, side: s.side, stakeWei: BigInt(s.stakeWei), seed: s.side === 0 ? s.seed : undefined });
    cancel.onclick = async () => { if (!needWallet()) return; cancel.disabled = true; try { await send(encodeCancel(s.matchId)); say('Cancelled, stake refunded.'); clear(); render(); } catch (e) { say((e as Error).message, true); cancel.disabled = false; } };
    timeout.onclick = async () => { if (!needWallet()) return; timeout.disabled = true; try { await send(encodeTimeoutClaim(s.matchId)); say('Pot split 50/50 after the timeout.'); clear(); render(); } catch (e) { say((e as Error).message, true); timeout.disabled = false; } };
    forget.onclick = () => { clear(); render(); };
    const actions = el('div', 'row'); actions.append(copy, resume);
    const actions2 = el('div', 'row'); actions2.append(cancel, timeout, forget);
    body.append(pill, stake, s.side === 0 ? linkBox : el('span'), actions, actions2);
    void refreshStatus(s.matchId, stake);
  }

  function renderJoin(matchId: string, stakeWei: string | null, relay: string): void {
    const pill = el('span', 'pill', 'Invitation · Horde seat');
    const info = el('p', 'note', 'Reading the wager…');
    const go = button('Join wager', 'primary');
    go.disabled = true;
    body.append(pill, info, go);
    void (async () => {
      try {
        const m = await readMatch(chain, contract, matchId);
        if (m.status !== MatchStatus.Open) { info.textContent = `This wager is ${STATUS_NAME[m.status] ?? 'unavailable'}.`; return; }
        if (stakeWei && BigInt(stakeWei) !== m.stake) { info.textContent = 'The link\'s stake does not match the escrow. Ask for a fresh link.'; return; }
        info.textContent = `${short(m.creator)} offers a ${formatZkLtc(m.stake)} zkLTC wager. Match it to take the Horde seat.`;
        go.disabled = false;
        go.onclick = async () => {
          const address = needWallet();
          if (!address) return;
          if (address.toLowerCase() === m.creator.toLowerCase()) return say('That is your own wager; open it from the creator\'s panel.', true);
          go.disabled = true;
          try {
            await send(encodeJoinMatch(matchId), m.stake);
            current = { matchId, seed: '', stakeWei: m.stake.toString(), relay, side: 1 };
            remember(current);
            say('Seated. Connecting to the relay…');
            render();
            o.onStartRelayMatch({ url: relay, matchId, side: 1, stakeWei: m.stake });
          } catch (e) { say((e as Error).message, true); go.disabled = false; }
        };
      } catch (e) { info.textContent = `Could not read the escrow: ${(e as Error).message}`; }
    })();
  }

  function renderSettlement(): void {
    const s = settlement!;
    const who = s.winner === 2 ? 'Draw: both stakes return' : s.winner === (current?.side ?? -1) ? 'You won the wager' : 'You lost the wager';
    const pill = el('span', `pill${s.winner !== 2 && s.winner === current?.side ? ' win' : ''}`, who);
    const info = el('p', 'note', s.sig ? 'The relay signed the result. Submit it to the escrow to pay out (either player may; it costs gas).' : 'The relay returned an unsigned result (no resolver key), so the escrow cannot pay on it. Use the timeout claim after the settle timeout.');
    const settle = button('Settle on chain', 'primary');
    settle.disabled = !s.sig;
    const withdraw = button('Withdraw held payout');
    const done = button('Done');
    settle.onclick = async () => {
      if (!needWallet()) return;
      settle.disabled = true;
      try {
        await send(encodeSettle({ matchId: s.matchId, winner: s.winner, logHash: s.logHash, sig: s.sig! }));
        say('Settled: the escrow paid out.');
        const a = wallet.snapshot().address;
        if (a && (await readPending(chain, contract, a)) > 0n) say('Settled. Your payout is held: press Withdraw.');
      } catch (e) { say((e as Error).message, true); settle.disabled = false; }
    };
    withdraw.onclick = async () => { if (!needWallet()) return; try { await send(encodeWithdraw()); say('Withdrawn.'); } catch (e) { say((e as Error).message, true); } };
    done.onclick = () => { settlement = null; clear(); render(); };
    const actions = el('div', 'row'); actions.append(settle, withdraw, done);
    body.append(pill, info, el('div', 'link', `log ${short(s.logHash)} · ${s.entries.length} moves`), actions);
  }

  /** No escrow configured: a friendly relayed match, no stakes. */
  function renderFriendly(): void {
    const relay = document.createElement('input');
    relay.type = 'url'; relay.value = joinRelay; relay.setAttribute('aria-label', 'relay url');
    const id = document.createElement('input');
    id.type = 'text'; id.placeholder = 'match id (leave empty to host)'; id.value = joinId ?? ''; id.setAttribute('aria-label', 'match id');
    const go = button(joinId ? 'Join friendly match' : 'Host friendly match', 'primary');
    const row1 = el('div', 'row'); row1.append(el('label', '', 'Relay'), relay);
    const row2 = el('div', 'row'); row2.append(el('label', '', 'Match'), id);
    body.append(row1, row2, go);
    go.onclick = () => {
      const url = relay.value.trim() || relayUrl;
      if (isBytes32(id.value.trim())) return o.onStartRelayMatch({ url, matchId: id.value.trim(), side: 1, stakeWei: 0n });
      const seed = randomSeed(), matchId = matchIdOf(seed);
      const share = new URL(location.origin + location.pathname); share.searchParams.set('match', matchId); share.searchParams.set('relay', url);
      body.append(el('div', 'link', share.toString()));
      say('Hosting. Send the link; the board starts when your opponent is seated.');
      o.onStartRelayMatch({ url, matchId, side: 0, stakeWei: 0n, seed });
    };
  }

  async function refreshStatus(matchId: string, target: HTMLElement): Promise<void> {
    try {
      const m = await readMatch(chain, contract, matchId);
      target.textContent = `${target.textContent} · ${STATUS_NAME[m.status] ?? '?'}${m.joiner && m.status >= MatchStatus.Live ? ` · vs ${short(m.joiner)}` : ''}`;
    } catch { /* offline: leave the cached line */ }
  }

  // ------------------------------------------------------------------ storage
  function recall(): Saved | null {
    try { const raw = localStorage.getItem(STORE); return raw ? (JSON.parse(raw) as Saved) : null; } catch { return null; }
  }
  function remember(s: Saved): void { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* private mode */ } }
  function clear(): void { current = null; try { localStorage.removeItem(STORE); } catch { /* ignore */ } }

  wallet.subscribe(() => render());
  render();

  const clockEl = el('div', 'clock');
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  return {
    element: box,
    showSettlement(s) { settlement = s; if (clockTimer) clearInterval(clockTimer); clockEl.remove(); render(); },
    showClock(c) {
      if (!clockEl.isConnected) box.append(clockEl);
      if (clockTimer) clearInterval(clockTimer);
      const tick = (): void => {
        const left = Math.max(0, Math.ceil((c.deadline - Date.now()) / 1000));
        clockEl.textContent = `${c.side === 0 ? 'Alliance' : 'Horde'} · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        clockEl.classList.toggle('low', left <= 10);
      };
      tick();
      clockTimer = setInterval(tick, 500);
    },
    setVisible(on) { box.hidden = !on; },
  };
}
