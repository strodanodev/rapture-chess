/**
 * Rapture Chess as a LitNode replayable title: the exact shape LitNode's `defineTitle` (titles/title.js) produces,
 * with no LitNode import, so the bundled ruleset is one import-free module that passes `sdk/conformance.mjs`.
 * `init`/`step` are the chess rules over the integer action log: the host node and its witnesses replay a match's
 * `{ seed, entries }` to the same `serialize()` root and the same scores, and that replayed result is what the
 * wager escrow pays on.
 */
import { createChessRules, MAX_BEATS, type ChessState } from '../rules/chessRules';

/** v2: draw offers, the clock in the log (timeouts, FIDE 6.9), the move limit. */
export const CHESS_RULESET_ID = 'rapture-chess.v2';
/** The first build (moves and concessions only, no clock): still registered, its artifact pinned in rulesets/. */
export const CHESS_RULESET_V1 = 'rapture-chess.v1';

export function defineChessTitle() {
  const rules = createChessRules();
  // The balance version pins the move encoding and the result rules; a change to either is a new ruleset id.
  const balance = { version: 'bal-chess-v2', apply: () => ({}) };
  return {
    manifest: {
      kind: 'replayable',
      rulesetId: CHESS_RULESET_ID,
      tickRate: 1,
      maxTicks: MAX_BEATS,
      modes: ['ranked', 'casual'],
      participants: 2,
      inputSchema: 'chess-v2:op3,move(from6,to6,promo3)|control(base15,inc8)|clock(ms28)',
      hiddenInfo: false,
      replicas: 3,
      standingFloor: 0,
      hostPolicy: { affinity: 'open' },
      exclusive: false,
      display: { title: 'Rapture Chess', url: 'https://rapture-chess.vercel.app/', description: 'The Rapture ARC 1 champions play chess. Alliance is White, Horde is Black.', cover: null, accent: '#ffc455' },
      balanceVersion: balance.version,
      services: {
        leaderboard: { kind: 'elo', k: 24 },
        credits: null,
        stats: { track: ['matches', 'wins', 'ticks'] },
      },
    },
    balance,
    init: rules.init,
    step: rules.step,
    done: rules.done,
    scores: rules.scores,
    /** What the root commits to: the whole state (there is no hidden information in chess). */
    serialize: (s: ChessState): ChessState => JSON.parse(JSON.stringify(s)) as ChessState,
    /** What a client may see: the position and the result, not the seed. */
    view: (s: ChessState) => ({ fen: s.fen, turn: s.turn, turnNo: s.turnNo, over: s.over, winner: s.winner, reason: s.reason, sans: s.sans.slice(), last: s.last, p: s.p, tc: s.tc, left: s.left, offer: s.offer }),
  };
}
