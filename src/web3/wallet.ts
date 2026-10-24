/**
 * Deckwright's wallet and holdings layer, pointed at the Rapture ARC 1 collection: connect a Liteforge wallet,
 * then learn which snapshot cards (designs) it holds so the roster can seat them. Nothing here signs or sends.
 */
import { createWallet, type Wallet } from 'tessaract/web/lib/wallet.js';
import { createHoldings, type Holdings } from 'tessaract/web/lib/holdings.js';
import type { Card, Collection } from '../roster';

export interface Web3Link {
  wallet: Wallet;
  /** Snapshot token ids (designs) the connected wallet holds; empty until connected. */
  owned: Set<string>;
  onChange(fn: () => void): void;
  toggle(): Promise<void>;
  restore(): Promise<void>;
  shortAddress(): string;
  /** The snapshot cards behind freshly minted token ids (a pack just opened). */
  identify(tokenIds: string[]): Promise<Card[]>;
  /** Re-read the wallet's holdings (after a pack opens). */
  refresh(): Promise<void>;
}

export function createWeb3Link(snapshot: Collection): Web3Link {
  const wallet = createWallet();
  const holdings: Holdings | null = /^0x[0-9a-fA-F]{40}$/.test(snapshot.collection.address ?? '')
    ? createHoldings({ collection: { ...snapshot.collection, cards: snapshot.cards } })
    : null;
  const listeners: Array<() => void> = [];
  const link: Web3Link = {
    wallet,
    owned: new Set(),
    onChange: (fn) => { listeners.push(fn); },
    async toggle() {
      if (wallet.snapshot().address) await wallet.disconnect();
      else { await wallet.connect(); await wallet.ensureChain().catch(() => {}); }
    },
    async restore() { await wallet.restore?.().catch(() => null); },
    shortAddress() { const a = wallet.snapshot().address; return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''; },
    async identify(tokenIds) {
      if (!holdings || !tokenIds.length) return [];
      const found = await holdings.identify(tokenIds);
      const byId = new Map(snapshot.cards.map((c) => [c.tokenId, c]));
      return tokenIds.map((t) => found.get(t)).map((c) => (c ? byId.get(String(c.tokenId)) : undefined)).filter((c): c is Card => !!c);
    },
    refresh: () => refresh(),
  };
  let gen = 0;
  async function refresh(): Promise<void> {
    const my = ++gen;
    const { address } = wallet.snapshot();
    let owned = new Set<string>();
    if (address && holdings) {
      try {
        const read = await holdings.read(address);
        const cards = await holdings.identify(read.tokens);
        owned = new Set([...cards.values()].filter((c): c is { tokenId: string } => !!c).map((c) => String(c.tokenId)));
      } catch (e) { console.warn('[chess] could not read holdings', e); }
    }
    if (my !== gen) return;
    link.owned = owned;
    for (const fn of listeners) fn();
  }
  wallet.subscribe(() => { void refresh(); });
  return link;
}
