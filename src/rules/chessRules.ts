/**
 * Rapture Chess rules (v2) in Deckwright's shape: `init(seed, participants)` then one `step` per log entry. Each
 * entry carries one 32-bit word per player. Any integer replays safely: a word that does nothing is a no-op. chess.js
 * does the chess; the state is plain JSON so a relay, a bot worker or a LitNode ruleset can replay the same log and
 * land on the same position.
 *
 *   bits 0-2   op      0 none, 1 move, 2 concede, 3 offer a draw, 4 accept a draw, 5 decline a draw,
 *                      6 time control (first entry only), 7 clock stamp
 *   move       bits 3-8 from, 9-14 to (a1 = 0 … h8 = 63), 15-17 promotion (0 none, 1 n, 2 b, 3 r, 4 q)
 *   control    bits 3-17 base seconds, 18-25 increment seconds
 *   clock      bits 3-30 milliseconds the side to move spent since the previous entry
 *
 * The clock is part of the log: the relay stamps every entry of a timed game with the time the side to move used,
 * in the slot of the player who did not act, and both players sign the log. A side whose time runs out loses, unless
 * the opponent has no way to checkmate, which is a draw (FIDE 6.9). A move that arrives after the flag fell is
 * ignored: the flag decides. The increment is added after each move (Fischer).
 *
 * Draws: a side may offer at any time (once per two plies); the opponent accepts or declines, or declines by moving.
 * An offer made while the opponent's offer stands is an acceptance. Threefold repetition, the fifty-move rule,
 * stalemate and insufficient material end the game automatically, as on most online servers.
 */
import { Chess, type Move, type Square } from 'chess.js';

export const Op = { None: 0, Move: 1, Concede: 2, Offer: 3, Accept: 4, Decline: 5, Control: 6, Clock: 7 } as const;
const PROMO = ['', 'n', 'b', 'r', 'q'] as const;
/** A log longer than this ends drawn (the manifest's maxTicks matches it). */
export const MAX_BEATS = 2000;
/** The longest single clock stamp a word holds (28 bits of milliseconds, about 74 hours). */
export const MAX_STAMP_MS = 0x0fffffff;
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Side = 0 | 1; // 0 white (Alliance), 1 black (Horde)

export interface TimeControl { base: number; inc: number }

export interface ChessState {
  v: 2;
  /** Log entries consumed so far. */
  beat: number;
  turn: Side;
  turnNo: number;
  over: boolean;
  /** -1 none yet, 0 or 1 a side, 2 a draw. */
  winner: -1 | 0 | 1 | 2;
  /** Moves so far, in SAN; the position is replayed from them (repetition and the fifty-move rule need the history). */
  sans: string[];
  fen: string;
  /** The word that took effect on the last beat, for the UI and animation. 0 when the beat was a no-op. */
  last: number;
  reason: string;
  seed: string;
  /** The two player ids, side 0 (White, Alliance) and side 1 (Black, Horde): inputs are keyed by them. */
  p: [string, string];
  /** The time control in milliseconds, or null for an untimed game. */
  tc: TimeControl | null;
  /** Milliseconds left on each side's clock, as of the last entry. */
  left: [number, number];
  /** The side whose draw offer stands, or -1. */
  offer: -1 | 0 | 1;
  /** The ply count when each side last offered a draw. */
  offeredAt: [number, number];
}

export const FILES = 'abcdefgh';
export const squareIndex = (sq: string): number => FILES.indexOf(sq[0]) + (Number(sq[1]) - 1) * 8;
export const squareName = (i: number): Square => `${FILES[i & 7]}${(i >> 3) + 1}` as Square;

export const encodeMove = (from: string, to: string, promotion = ''): number =>
  Op.Move | (squareIndex(from) << 3) | (squareIndex(to) << 9) | (Math.max(0, PROMO.indexOf(promotion as never)) << 15);
export const concede = (): number => Op.Concede;
export const offerDraw = (): number => Op.Offer;
export const acceptDraw = (): number => Op.Accept;
export const declineDraw = (): number => Op.Decline;
/** The time control word: base and increment in whole seconds (base up to 32767 s, increment up to 255 s). */
export const encodeControl = (baseSec: number, incSec: number): number =>
  Op.Control | ((Math.max(0, Math.min(0x7fff, Math.floor(baseSec))) << 3) | (Math.max(0, Math.min(0xff, Math.floor(incSec))) << 18));
/** The clock stamp word: milliseconds the side to move spent since the previous entry. */
export const encodeClock = (ms: number): number => Op.Clock | (Math.max(0, Math.min(MAX_STAMP_MS, Math.floor(ms))) << 3);

export function decodeAction(x: number): { op: number; from: Square; to: Square; promotion: string } {
  return { op: x & 7, from: squareName((x >>> 3) & 63), to: squareName((x >>> 9) & 63), promotion: PROMO[(x >>> 15) & 7] ?? '' };
}
export const decodeControl = (x: number): TimeControl => ({ base: ((x >>> 3) & 0x7fff) * 1000, inc: ((x >>> 18) & 0xff) * 1000 });

/** The player action in an entry's two words (the word that is not a clock stamp), or 0. */
export const entryAction = (inputs: readonly number[]): number => {
  for (const w of inputs) if (w && (w & 7) !== Op.Clock) return w | 0;
  return 0;
};

/** The position a state describes, replayed from its moves. */
export function positionOf(state: Pick<ChessState, 'sans'>): Chess {
  const c = new Chess();
  for (const san of state.sans) c.move(san);
  return c;
}

/**
 * True when `side` cannot checkmate by any legal sequence: a bare king, a lone knight against a bare king, or only
 * bishops on one square colour against nothing but bishops on that same colour. With any other material a mate is possible (with the opponent's help),
 * so a flag against it loses.
 */
export function cannotMate(c: Chess, side: Side): boolean {
  const own = side === 0 ? 'w' : 'b';
  const mine: Array<{ type: string; light: boolean }> = [];
  const theirs: Array<{ type: string; light: boolean }> = [];
  const board = c.board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = board[r][f];
    if (!p || p.type === 'k') continue;
    (p.color === own ? mine : theirs).push({ type: p.type, light: (r + f) % 2 === 0 });
  }
  if (mine.length === 0) return true;
  if (mine.length === 1 && mine[0].type === 'n') return theirs.length === 0;
  if (!mine.every((p) => p.type === 'b')) return false;
  const light = mine[0].light;
  return mine.every((p) => p.light === light) && theirs.every((p) => p.type === 'b' && p.light === light);
}

export interface ChessRules {
  init(seed: string, participants: string[]): ChessState;
  step(state: ChessState, inputs: Record<string, number>): ChessState;
  done(state: ChessState): boolean;
  scores(state: ChessState): Record<string, number>;
  legalActions(state: ChessState): number[];
  isLegal(state: ChessState, action: number): boolean;
  /** The chess.js move an action would make in this state, or null when it is not legal. */
  resolve(state: ChessState, action: number): Move | null;
  /** Whether a draw word (offer, accept, decline) from `side` would take effect now. */
  canDraw(state: ChessState, side: Side, action: number): boolean;
}

export function createChessRules(): ChessRules {

  function resolve(state: ChessState, action: number): Move | null {
    if (state.over || (action & 7) !== Op.Move) return null;
    const { from, to, promotion } = decodeAction(action);
    const c = new Chess(state.fen);
    const legal = c.moves({ square: from, verbose: true }).find((m) => m.to === to && (m.promotion ?? '') === (m.promotion ? promotion || 'q' : ''));
    return legal ?? null;
  }

  function canDraw(state: ChessState, side: Side, action: number): boolean {
    if (state.over) return false;
    const other = side === 0 ? 1 : 0;
    switch (action & 7) {
      case Op.Offer: return state.offer === other || (state.offer === -1 && state.sans.length - state.offeredAt[side] >= 2);
      case Op.Accept: case Op.Decline: return state.offer === other;
      default: return false;
    }
  }

  function end(state: ChessState, winner: 0 | 1 | 2, reason: string): ChessState {
    state.over = true; state.winner = winner; state.reason = reason; state.offer = -1;
    return state;
  }

  function settle(state: ChessState, c: Chess): ChessState {
    state.fen = c.fen();
    state.turn = c.turn() === 'w' ? 0 : 1;
    if (c.isCheckmate()) return end(state, state.turn === 0 ? 1 : 0, 'checkmate');
    if (c.isStalemate()) return end(state, 2, 'stalemate');
    if (c.isThreefoldRepetition()) return end(state, 2, 'threefold repetition');
    if (c.isInsufficientMaterial()) return end(state, 2, 'insufficient material');
    if (c.isDrawByFiftyMoves()) return end(state, 2, 'fifty-move rule');
    return state;
  }

  return {
    init(seed, who) {
      return {
        v: 2, beat: 0, turn: 0, turnNo: 1, over: false, winner: -1, sans: [], fen: new Chess().fen(), last: 0, reason: '', seed,
        p: [String(who[0]), String(who[1])], tc: null, left: [0, 0], offer: -1, offeredAt: [-2, -2],
      };
    },
    step(prev, inputs) {
      const state: ChessState = { ...prev, sans: prev.sans.slice(), left: [prev.left[0], prev.left[1]], offeredAt: [prev.offeredAt[0], prev.offeredAt[1]], beat: prev.beat + 1, last: 0 };
      if (state.over) return state;
      const words = [(inputs[state.p[0]] ?? 0) | 0, (inputs[state.p[1]] ?? 0) | 0];
      const stamps = words.filter((w) => (w & 7) === Op.Clock);
      if (stamps.length === 2) return state; // one stamp per entry
      const acts = words.map((w) => ((w & 7) === Op.Clock ? 0 : w));

      // 1. the time control, in the first entry only
      for (const side of [0, 1] as const) {
        if ((acts[side] & 7) === Op.Control) {
          if (state.tc || state.beat !== 1) return state;
          const tc = decodeControl(acts[side]);
          if (tc.base <= 0) return state;
          state.tc = tc; state.left = [tc.base, tc.base]; state.last = acts[side];
          return state;
        }
      }

      // 2. the clock: the stamp is charged to the side to move; a flag ends the game before anything else counts
      if (state.tc && stamps.length) {
        const mover = state.turn;
        state.left[mover] -= stamps[0] >>> 3;
        if (state.left[mover] <= 0) {
          state.left[mover] = 0;
          state.last = stamps[0];
          const other = mover === 0 ? 1 : 0;
          return cannotMate(positionOf(state), other) ? end(state, 2, 'timeout vs insufficient material') : end(state, other, 'timeout');
        }
      }

      // 3. a concession, from either side
      for (const side of [0, 1] as const) {
        if ((acts[side] & 7) === Op.Concede) { state.last = acts[side]; return end(state, side === 0 ? 1 : 0, 'concession'); }
      }

      // 4. draw offers, from either side
      for (const side of [0, 1] as const) {
        const x = acts[side], op = x & 7;
        if (op < Op.Offer || op > Op.Decline || !canDraw(state, side, x)) continue;
        state.last = x;
        if (op === Op.Decline) { state.offer = -1; continue; }
        if (op === Op.Accept || state.offer !== -1) return end(state, 2, 'agreement');
        state.offer = side; state.offeredAt[side] = state.sans.length;
      }

      // 5. the move, from the side to move
      const mover = state.turn;
      const x = acts[mover];
      const move = resolve(state, x);
      if (move) {
        const c = positionOf(state);
        c.move({ from: move.from, to: move.to, promotion: move.promotion });
        state.sans.push(move.san);
        state.last = x;
        state.turnNo = Math.floor(state.sans.length / 2) + 1;
        if (state.offer !== -1 && state.offer !== mover) state.offer = -1; // moving declines the opponent's offer
        if (state.tc) state.left[mover] += state.tc.inc;
        settle(state, c);
      }
      if (!state.over && state.beat >= MAX_BEATS) end(state, 2, 'move limit');
      return state;
    },
    done: (s) => s.over,
    scores(s) {
      const w = s.winner === 2 ? [0.5, 0.5] : s.winner === 0 ? [1, 0] : s.winner === 1 ? [0, 1] : [0, 0];
      return Object.fromEntries(s.p.map((p, i) => [p, w[i]]));
    },
    legalActions(s) {
      if (s.over) return [];
      return new Chess(s.fen).moves({ verbose: true }).map((m) => encodeMove(m.from, m.to, m.promotion ?? ''));
    },
    isLegal: (s, x) => resolve(s, x) !== null,
    resolve,
    canDraw,
  };
}
