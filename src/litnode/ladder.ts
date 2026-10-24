/**
 * The Rapture Chess ladder, read from the LitNode mesh. Every node folds the same table from MatchBook's finalized
 * results (`GET /progress?ruleset=`), so any live node will do: the page finds one through NodeDirectory on chain
 * (the freshest announced https address that answers), or uses VITE_LITNODE_URL / the node that hosted a match.
 */
import { createReadChain } from '../web3/rpc';
import { words, uintAt } from 'tessaract/web/lib/abi.js';
import { CHESS_RULESET_ID } from '../web3/wager';

const NODE_DIRECTORY = '0xac0C73008028E3eAA05Bc5C72f0C233F94b4E3df';
const SEL = { keys: '0x307540f6', entryOf: '0x82fb8643' };
const env = import.meta.env as Record<string, string | undefined>;
const FRESH_S = 7 * 24 * 3600;

export interface LadderLine {
  rank: number; player: string; level: number; xp: number; xpTotal: number; rating: number;
  wins: number; losses: number; draws: number; matches: number; streak: number; bestStreak: number;
}
export interface Ladder { node: string; source: string; scope: string; players: number; ranking: LadderLine[]; finalized: number; pending: number }

function str(w: string[], head: number, hex: string): string {
  const off = Number(uintAt(w, head)) / 32;
  const len = Number(uintAt(w, off));
  const start = 2 + (off + 1) * 64;
  const bytes = hex.slice(start, start + len * 2).match(/../g) ?? [];
  return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))));
}

/** Announced node addresses, freshest first. */
export async function meshNodes(limit = 16): Promise<string[]> {
  const chain = createReadChain();
  const kw = words(await chain.call({ to: NODE_DIRECTORY, data: SEL.keys }));
  const n = Number(uintAt(kw, 1));
  const keys = Array.from({ length: n }, (_, i) => `0x${kw[2 + i]}`).slice(-limit);
  const out: Array<{ url: string; at: number }> = [];
  const now = Date.now() / 1000;
  // a small pool: the public gateway rate-limits bursts
  for (let i = 0; i < keys.length; i += 4) {
    await Promise.all(keys.slice(i, i + 4).map(async (k) => {
      try {
        const hex = await chain.call({ to: NODE_DIRECTORY, data: SEL.entryOf + k.slice(2) });
        const w = words(hex);
        const url = str(w, 0, hex), at = Number(uintAt(w, 2));
        if (/^https:\/\//.test(url) && now - at < FRESH_S) out.push({ url: url.replace(/\/+$/, ''), at });
      } catch { /* skip a key that will not read */ }
    }));
  }
  return out.sort((a, b) => b.at - a.at).map((x) => x.url);
}

async function progress(node: string): Promise<Ladder> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${node}/progress?ruleset=${encodeURIComponent(CHESS_RULESET_ID)}&limit=100`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${node} answered ${r.status}`);
    const j = await r.json() as { source: string; scope: string; players: number; ranking: LadderLine[]; counts?: { official?: number; pending?: number } | null };
    return { node, source: j.source, scope: j.scope, players: j.players, ranking: j.ranking ?? [], finalized: j.counts?.official ?? 0, pending: j.counts?.pending ?? 0 };
  } finally { clearTimeout(t); }
}

let cache: { at: number; ladder: Ladder } | null = null;
/** The ladder from the first node that answers. `hint` (a node that hosted a match) is tried first. */
export async function readLadder(hint?: string | null): Promise<Ladder> {
  if (cache && Date.now() - cache.at < 60_000) return cache.ladder;
  const tried = new Set<string>();
  const attempt = async (url: string | null | undefined) => {
    if (!url) return null;
    const u = url.replace(/\/+$/, '');
    if (tried.has(u)) return null;
    tried.add(u);
    try { return await progress(u); } catch { return null; }
  };
  let got = (await attempt(hint)) ?? (await attempt(env.VITE_LITNODE_URL));
  // the mesh: race the freshest few at once (quick tunnels go stale; a dead one only costs its timeout)
  if (!got) {
    const urls = (await meshNodes()).filter((u) => !tried.has(u)).slice(0, 6);
    got = await Promise.any(urls.map((u) => progress(u))).catch(() => null);
  }
  if (!got) throw new Error('No LitNode node answered. The mesh may be restarting: try again in a minute.');
  cache = { at: Date.now(), ladder: got };
  return got;
}
