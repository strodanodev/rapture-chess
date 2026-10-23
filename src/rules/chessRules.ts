/**
 * Rapture Chess rules in Deckwright's shape: `init(seed, participants)` then one `step` per log entry, where the
 * acting player's frame carries one 32-bit integer and the other side sends 0. Any integer replays safely: an
 * illegal action is a no-op. chess.js does the chess; the state is plain JSON so a relay, a bot worker or a
 * LitNode ruleset can replay the same log and land on the same position.
 *
 *   bits 0-2   op      0 none, 1 move, 2 concede (honoured on either side's frame)
 *   bits 3-8   from    square index, a1 = 0 … h8 = 63
 *   bits 9-14  to      square index
 *   bits 15-17 promo   0 none, 1 knight, 2 bishop, 3 rook, 4 queen
 */
import { Chess, type Move, type Square } from 'chess.js';

export const Op = { None: 0, Move: 1, Concede: 2 } as const;
const PROMO = ['', 'n', 'b', 'r', 'q'] as const;
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Side = 0 | 1; // 0 white (Alliance), 1 black (Horde)

export interface ChessState {
  v: 1;
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
  /** Last accepted action, for the UI and animation. 0 when the beat was a no-op. */
  last: number;
  reason: string;
  seed: string;
}

export const FILES = 'abcdefgh';
export const squareIndex = (sq: string): number => FILES.indexOf(sq[0]) + (Number(sq[1]) - 1) * 8;
export const squareName = (i: number): Square => `${FILES[i & 7]}${(i >> 3) + 1}` as Square;

export const encodeMove = (from: string, to: string, promotion = ''): number =>
  Op.Move | (squareIndex(from) << 3) | (squareIndex(to) << 9) | (Math.max(0, PROMO.indexOf(promotion as never)) << 15);
export const concede = (): number => Op.Concede;
export function decodeAction(x: number): { op: number; from: Square; to: Square; promotion: string } {
  return { op: x & 7, from: squareName((x >>> 3) & 63), to: squareName((x >>> 9) & 63), promotion: PROMO[(x >>> 15) & 7] ?? '' };
}

/** The position a state describes, replayed from its moves. */
export function positionOf(state: Pick<ChessState, 'sans'>): Chess {
  const c = new Chess();
  for (const san of state.sans) c.move(san);
  return c;
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
}

export function createChessRules(): ChessRules {
  let participants: string[] = [];

  function resolve(state: ChessState, action: number): Move | null {
    if (state.over || (action & 7) !== Op.Move) return null;
    const { from, to, promotion } = decodeAction(action);
    const c = new Chess(state.fen);
    const legal = c.moves({ square: from, verbose: true }).find((m) => m.to === to && (m.promotion ?? '') === (m.promotion ? promotion || 'q' : ''));
    return legal ?? null;
  }

  function settle(state: ChessState, c: Chess): ChessState {
    state.fen = c.fen();
    state.turn = c.turn() === 'w' ? 0 : 1;
    if (c.isCheckmate()) { state.over = true; state.winner = state.turn === 0 ? 1 : 0; state.reason = 'checkmate'; }
    else if (c.isStalemate()) { state.over = true; state.winner = 2; state.reason = 'stalemate'; }
    else if (c.isThreefoldRepetition()) { state.over = true; state.winner = 2; state.reason = 'threefold repetition'; }
    else if (c.isInsufficientMaterial()) { state.over = true; state.winner = 2; state.reason = 'insufficient material'; }
    else if (c.isDrawByFiftyMoves()) { state.over = true; state.winner = 2; state.reason = 'fifty-move rule'; }
    return state;
  }

  return {
    init(seed, who) {
      participants = who.slice(0, 2);
      return { v: 1, beat: 0, turn: 0, turnNo: 1, over: false, winner: -1, sans: [], fen: new Chess().fen(), last: 0, reason: '', seed };
    },
    step(prev, inputs) {
      const state: ChessState = { ...prev, sans: prev.sans.slice(), beat: prev.beat + 1, last: 0 };
      if (state.over) return state;
      // concede is honoured from either seat; a move only from the side to act
      for (const side of [0, 1] as const) {
        if (((inputs[participants[side]] ?? 0) & 7) === Op.Concede) {
          state.over = true; state.winner = side === 0 ? 1 : 0; state.reason = 'concession'; state.last = Op.Concede;
          return state;
        }
      }
      const x = (inputs[participants[state.turn]] ?? 0) | 0;
      const move = resolve(state, x);
      if (!move) return state;
      const c = positionOf(state);
      c.move({ from: move.from, to: move.to, promotion: move.promotion });
      state.sans.push(move.san);
      state.last = x;
      state.turnNo = Math.floor(state.sans.length / 2) + 1;
      return settle(state, c);
    },
    done: (s) => s.over,
    scores(s) {
      const w = s.winner === 2 ? [0.5, 0.5] : s.winner === 0 ? [1, 0] : s.winner === 1 ? [0, 1] : [0, 0];
      return Object.fromEntries(participants.map((p, i) => [p, w[i]]));
    },
    legalActions(s) {
      if (s.over) return [];
      return new Chess(s.fen).moves({ verbose: true }).map((m) => encodeMove(m.from, m.to, m.promotion ?? ''));
    },
    isLegal: (s, x) => resolve(s, x) !== null,
    resolve,
  };
}
