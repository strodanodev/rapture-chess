/**
 * The wager panel: put zkLTC at stake under your LitNode player key (escrow `stake`), play placed matches from
 * the arcade, then claim a settled match with the host node's own signed delta (`claim`). Every transaction goes
 * through the Deckwright wallet; every dynamic string goes through textContent.
 *
 * Wiring (main.ts):
 *   const wager = mountWager({ root, web3, playerKey: () => shell?.init.player.id ?? null, nodeUrl: () => shell?.init.node.url ?? null });
 *   // when an arcade match ends: wager.showMatch(matchId, settled.signatures)
 */
import './wager.css';
import { createChain, type ChainClient } from 'deckwright/web/lib/chain.js';
import type { Web3Link } from '../web3/wallet';
import {
  claimProblem, deltaClaimBytes, deltaWinner, encodeClaim, encodeClaimWithWinner, encodeRequestUnstake, winnerSignature, encodeStake, encodeUnstake, encodeWithdraw, formatZkLtc,
  isLitId, parseZkLtc, readClaimed, readPending, readStake, readUnstakeDelay, readWalletOf, type LitNodeDelta,
} from '../web3/wager';

export interface WagerMountOptions {
  root: HTMLElement;
  web3: Web3Link;
  /** The LitNode player key (64 hex) the arcade shell plays under, or null outside the arcade. */
  playerKey(): string | null;
  /** The LitNode host the match ran on (http(s) origin), or null. */
  nodeUrl(): string | null;
  /** Overrides for the build-time defaults. */
  contract?: string;
  rpc?: string;
}
export interface WagerPanel {
  readonly element: HTMLElement;
  /**
   * A match just ended on `nodeUrl()`: offer to claim it once the node has settled it. `signatures` are the ledger
   * signatures the relay reported (RelaySettled.signatures): kept so a match the loser never signed can still pay.
   */
  showMatch(matchId: string, signatures?: Record<string, string>): void;
  /** Hide or show the whole panel (the title screen vs the game). */
  setVisible(on: boolean): void;
  /** Re-read the escrow (after a wallet or key change). */
  refresh(): void;
}

const STORE = 'rapture-chess.wager.v2';
const STORE_SIGS = 'rapture-chess.wager.sigs';
const env = import.meta.env as Record<string, string | undefined>;
const ZERO = '0x0000000000000000000000000000000000000000';
const el = (tag: string, cls = '', text = ''): HTMLElement => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const button = (text: string, cls = ''): HTMLButtonElement => { const b = document.createElement('button'); b.textContent = text; if (cls) b.className = cls; return b; };
const short = (a: string): string => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function mountWager(o: WagerMountOptions): WagerPanel {
  const contract = o.contract ?? env.VITE_WAGER_ADDRESS ?? '';
  const rpc = o.rpc ?? env.VITE_RPC_URL ?? 'https://liteforge.rpc.caldera.xyz/http';
  const chain: ChainClient = createChain(rpc);
  const wallet = o.web3.wallet;
  const configured = /^0x[0-9a-fA-F]{40}$/.test(contract);

  const box = el('section', 'wager');
  box.setAttribute('aria-label', 'zkLTC stakes');
  const title = el('h3', '', 'zkLTC stakes');
  const note = el('p', 'note');
  const body = el('div', 'body');
  box.append(title, note, body);
  o.root.append(box);
  const say = (text: string, err = false): void => { note.textContent = text; note.classList.toggle('err', err); };

  let stake: { amount: bigint; unstakeAt: number; key: string | null } | null = null;
  let pending = 0n;
  let delay = 0;
  let matchId: string | null = recallMatch();
  let signatures: Record<string, string> = recallSigs(matchId);
  let delta: LitNodeDelta | null = null;
  let claimedAlready = false;
  let tick: ReturnType<typeof setInterval> | null = null;

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
    if (!configured) { say('No escrow is configured for this build (VITE_WAGER_ADDRESS): stakes are off. Matches still play and settle on LitNode.', true); return; }
    renderStake();
    if (matchId) renderClaim(matchId);
  }

  function renderStake(): void {
    const address = wallet.snapshot().address;
    const key = o.playerKey();
    const line = el('p', 'line');
    if (!address) line.textContent = 'Connect a wallet to put zkLTC at stake.';
    else if (!stake) line.textContent = 'Reading your stake…';
    else if (stake.amount === 0n) line.textContent = 'Nothing at stake yet.';
    else line.textContent = `${formatZkLtc(stake.amount)} zkLTC at stake under key ${short(stake.key ?? '')}`;
    body.append(line);
    if (pending > 0n) {
      const w = button(`Withdraw ${formatZkLtc(pending)} zkLTC held for you`);
      w.onclick = async () => { if (!needWallet()) return; w.disabled = true; try { await send(encodeWithdraw()); say('Withdrawn.'); await refresh(); } catch (e) { say((e as Error).message, true); w.disabled = false; } };
      body.append(w);
    }
    body.append(el('p', 'note', 'A stake pays out on any placed Rapture Chess match against another staked player: twice the smaller stake to the winner, nothing moves on a draw. The result is LitNode\'s own: the host node\'s signed delta, final on MatchBook when ranked.'));

    // stake form
    const form = el('div', 'row');
    const amount = document.createElement('input');
    amount.placeholder = 'zkLTC, e.g. 0.05';
    amount.inputMode = 'decimal';
    const go = button('Stake', 'primary');
    form.append(amount, go);
    body.append(form);
    const boundKey = stake?.key ?? null;
    const useKey = boundKey ?? key;
    if (!useKey) {
      go.disabled = true;
      body.append(el('p', 'note', 'Open Rapture Chess from the LitNode arcade to stake: the stake is bound to the player key the arcade signs with.'));
    } else if (boundKey && key && boundKey !== key) {
      body.append(el('p', 'note err', `Your stake is bound to key ${short(boundKey)}, but the arcade plays as ${short(key)}. Unstake first, or play with the bound key.`));
    } else {
      body.append(el('p', 'note', `Player key ${short(useKey)}${boundKey ? ' (bound)' : ''}.`));
    }
    go.onclick = async () => {
      if (!needWallet() || !useKey) return;
      let wei: bigint;
      try { wei = parseZkLtc(amount.value); if (wei <= 0n) throw new Error('stake must be above zero'); } catch (e) { return say((e as Error).message, true); }
      go.disabled = true;
      try {
        if (!boundKey) {
          const holder = await readWalletOf(chain, contract, useKey);
          if (holder !== ZERO && holder.toLowerCase() !== (wallet.snapshot().address ?? '').toLowerCase()) throw new Error(`key ${short(useKey)} is staked by another wallet`);
        }
        await send(encodeStake(useKey), wei);
        say(`${formatZkLtc(wei)} zkLTC staked.`);
        await refresh();
      } catch (e) { say((e as Error).message, true); go.disabled = false; }
    };

    // unstake
    if (stake && stake.amount > 0n) {
      const row = el('div', 'row');
      if (!stake.unstakeAt) {
        const req = button('Request unstake');
        req.onclick = async () => { if (!needWallet()) return; req.disabled = true; try { await send(encodeRequestUnstake()); say(`Unstake requested: available in ${mmss(delay)}. A match settled meanwhile can still be claimed.`); await refresh(); } catch (e) { say((e as Error).message, true); req.disabled = false; } };
        row.append(req);
      } else {
        const left = Math.max(0, stake.unstakeAt - Math.floor(Date.now() / 1000));
        const un = button(left > 0 ? `Unstake in ${mmss(left)}` : 'Unstake');
        un.disabled = left > 0;
        un.onclick = async () => { if (!needWallet()) return; un.disabled = true; try { await send(encodeUnstake()); say('Stake returned.'); await refresh(); } catch (e) { say((e as Error).message, true); un.disabled = false; } };
        row.append(un);
        if (left > 0 && !tick) tick = setInterval(() => { if (!box.isConnected || !stake?.unstakeAt) { if (tick) clearInterval(tick); tick = null; return; } render(); }, 1000);
      }
      body.append(row);
    }
  }

  function renderClaim(id: string): void {
    const sec = el('div', 'claim');
    sec.append(el('h4', '', 'Settled match'));
    sec.append(el('p', 'line', `Match ${short(id)}`));
    const info = el('p', 'note');
    sec.append(info);
    const row = el('div', 'row');
    const fetchBtn = button('Check settlement');
    const claimBtn = button('Claim', 'primary');
    const forget = button('Dismiss');
    claimBtn.disabled = true;
    row.append(fetchBtn, claimBtn, forget);
    sec.append(row);
    body.append(sec);

    const describe = (): void => {
      if (!delta) { info.textContent = 'Ask the host node whether it has settled this match.'; return; }
      const problem = claimProblem(delta, id, signatures);
      const who = deltaWinner(delta);
      const outcome = who === 2 ? 'a draw' : `${who === 0 ? 'Alliance' : 'Horde'} won`;
      const label = delta.official ? 'official' : (delta.verification ?? delta.attestation);
      if (claimedAlready) { info.textContent = `Settled: ${outcome} (${label}). The stakes were already paid out.`; claimBtn.disabled = true; return; }
      if (problem) { info.textContent = `Settled (${label}): ${outcome}, but it cannot pay out: ${problem}.`; claimBtn.disabled = true; return; }
      info.textContent = `Settled: ${outcome} (${label}). Claim pays the stakes out as LitNode's result says.`;
      claimBtn.disabled = false;
    };
    describe();

    fetchBtn.onclick = async () => {
      const node = o.nodeUrl();
      if (!node) return say('No LitNode host for this match: open it from the arcade.', true);
      fetchBtn.disabled = true;
      try {
        const r = await fetch(`${node.replace(/\/+$/, '')}/delta/${encodeURIComponent(id)}`);
        if (r.status === 404) throw new Error('the node has not settled this match yet: try again in a moment');
        if (!r.ok) throw new Error(`node answered ${r.status}`);
        const d = (await r.json()) as LitNodeDelta & { delta?: LitNodeDelta };
        delta = d.delta ?? d;
        claimedAlready = await readClaimed(chain, contract, id).catch(() => false);
        say('Settlement read from the host node.');
      } catch (e) { say((e as Error).message, true); }
      fetchBtn.disabled = false;
      describe();
    };
    claimBtn.onclick = async () => {
      if (!needWallet() || !delta) return;
      claimBtn.disabled = true;
      try {
        const { json, hostSig } = deltaClaimBytes(delta);
        await send(delta.attestation === 'players' ? encodeClaim(id, json, hostSig) : encodeClaimWithWinner(id, json, hostSig, winnerSignature(delta, signatures)));
        claimedAlready = true;
        say('Claimed: the stakes are paid out.');
        await refresh();
        describe();
      } catch (e) { say((e as Error).message, true); claimBtn.disabled = false; }
    };
    forget.onclick = () => { matchId = null; delta = null; claimedAlready = false; signatures = {}; rememberMatch(null); render(); };
  }

  // ------------------------------------------------------------------ state
  async function refresh(): Promise<void> {
    const address = wallet.snapshot().address;
    if (!configured || !address) { stake = null; pending = 0n; render(); return; }
    try {
      const [s, p, d] = await Promise.all([readStake(chain, contract, address), readPending(chain, contract, address), delay ? Promise.resolve(delay) : readUnstakeDelay(chain, contract)]);
      stake = s; pending = p; delay = d;
    } catch (e) { say(`Could not read the escrow: ${(e as Error).message}`, true); }
    render();
  }
  function recallMatch(): string | null {
    try { const v = localStorage.getItem(STORE); return v && isLitId(v) ? v : null; } catch { return null; }
  }
  function rememberMatch(id: string | null): void {
    try {
      if (id) localStorage.setItem(STORE, id); else localStorage.removeItem(STORE);
      if (id) localStorage.setItem(STORE_SIGS, JSON.stringify({ id, signatures })); else localStorage.removeItem(STORE_SIGS);
    } catch { /* private mode */ }
  }
  function recallSigs(id: string | null): Record<string, string> {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_SIGS) ?? 'null') as { id?: string; signatures?: Record<string, string> } | null;
      return v && v.id === id && v.signatures ? v.signatures : {};
    } catch { return {}; }
  }

  wallet.subscribe(() => { void refresh(); });
  render();
  void refresh();

  return {
    element: box,
    showMatch(id, sigs) {
      if (!isLitId(id)) return;
      if (matchId !== id) { delta = null; claimedAlready = false; signatures = {}; }
      signatures = { ...signatures, ...(sigs ?? {}) };
      matchId = id;
      rememberMatch(id);
      render();
    },
    setVisible(on) { box.hidden = !on; },
    refresh() { void refresh(); },
  };
}
