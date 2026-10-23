/**
 * The Rapture ARC 1 collection as two chess armies. Alliance is White, Horde is Black; each piece type is held by
 * one Kind: Gods take the royal seats, Titans the rooks, Kings the bishops, Demigods the knights and Mortals the
 * pawn line. Cards the player's wallet holds are seated first, so a collector fields their own champions.
 */
import { seededRandom, shuffle } from 'deckwright/src/core/rng.ts';
import type { PieceType, Side } from './rules/chessRules';

export interface Card {
  tokenId: string;
  slug: string;
  name: string;
  epithet: string;
  kind: 'God' | 'Titan' | 'King' | 'Demigod' | 'Mortal';
  element: 'Water' | 'Earth' | 'Lava' | 'Metal';
  faction: 'Alliance' | 'Horde';
  stats: { str: number; agi: number; res: number; int: number };
  art: string;
  /** Lore and provenance from the token itself (scripts/lore-snapshot.mjs); absent in an older snapshot. */
  lore?: CardLore;
}
/** What the token's on-chain metadata says about the champion, and the soul file its keccak256 pins. */
export interface CardLore {
  bio: string | null;
  path: string | null;
  alignment: string | null;
  frame: string | null;
  kit: string | null;
  /** From the soul: its own line, how it speaks, what it holds to, its temper, how it fights, where it breaks. */
  quote: string | null;
  /** The champion's story, in souls written as prose. */
  story?: string | null;
  voice: string | null;
  values: string | null;
  temperament: string | null;
  battle: string | null;
  weakness: string | null;
  soulHash: string | null;
  designHash: string | null;
  artHash: string | null;
  avatarHash: string | null;
  /** The soul's keccak256 matched the hash the token pins when it was snapshotted. */
  soulVerified: boolean;
}
export interface Collection {
  collection: { name: string; chainId: number; rpc: string; address: string; explorer: string; setId: number; count: number };
  cards: Card[];
}

export const ELEMENT_COLOR: Record<Card['element'], string> = { Water: '#38a8ff', Earth: '#4fd66a', Lava: '#ff6a2a', Metal: '#d9e2f2' };
export const KIND_FOR: Record<PieceType, Card['kind']> = { k: 'God', q: 'God', r: 'Titan', b: 'King', n: 'Demigod', p: 'Mortal' };
export const FACTION_OF: Record<Side, Card['faction']> = { 0: 'Alliance', 1: 'Horde' };
export const PIECE_NAME: Record<PieceType, string> = { k: 'King', q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn' };
export const power = (c: Card): number => c.stats.str + c.stats.agi + c.stats.res + c.stats.int;

/** Starting squares per side and type, in seating order. */
const SEATS: Record<PieceType, [string, string]> = {
  k: ['e1', 'e8'], q: ['d1', 'd8'], r: ['a1 h1', 'a8 h8'], b: ['c1 f1', 'c8 f8'], n: ['b1 g1', 'b8 g8'],
  p: ['a2 b2 c2 d2 e2 f2 g2 h2', 'a7 b7 c7 d7 e7 f7 g7 h7'],
};

/** square -> card for one side. Owned cards first (then by power), a seeded shuffle among equals so armies vary. */
export function buildRoster(cards: Card[], side: Side, owned: Set<string>, seed: string): Map<string, Card> {
  const rnd = seededRandom(`${seed}:${side}`);
  const faction = FACTION_OF[side];
  const roster = new Map<string, Card>();
  const gods = pick(cards, faction, 'God', owned, rnd);
  seat(roster, SEATS.k[side], [gods[0]]);
  seat(roster, SEATS.q[side], [gods[1] ?? gods[0]]);
  for (const t of ['r', 'b', 'n', 'p'] as const) seat(roster, SEATS[t][side], pick(cards, faction, KIND_FOR[t], owned, rnd));
  return roster;
}

function pick(cards: Card[], faction: Card['faction'], kind: Card['kind'], owned: Set<string>, rnd: () => number): Card[] {
  const pool = cards.filter((c) => c.faction === faction && c.kind === kind);
  const held = shuffle(pool.filter((c) => owned.has(c.tokenId)), rnd);
  const rest = shuffle(pool.filter((c) => !owned.has(c.tokenId)), rnd).sort((a, b) => power(b) - power(a));
  // owned champions lead; the rest follow strongest first, but shuffled inside the top half so games differ
  const top = shuffle(rest.slice(0, Math.ceil(rest.length / 2)), rnd);
  return [...held, ...top, ...rest.slice(top.length)];
}

function seat(roster: Map<string, Card>, squares: string, candidates: Card[]): void {
  const list = squares.split(' ');
  list.forEach((sq, i) => { const c = candidates[i % candidates.length]; if (c) roster.set(sq, c); });
}
