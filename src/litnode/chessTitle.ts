/**
 * Rapture Chess as a LitNode replayable title: the same shape Deckwright's `defineTcgTitle` produces (and LitNode's
 * `defineTitle`), so a bundled ruleset needs no LitNode import. `init`/`step` are the chess rules over the integer
 * action log, so a node and its witnesses replay a relay's `{ seed, entries }` to the same result the escrow was paid on.
 */
import { createChessRules, type ChessState } from '../rules/chessRules';

export const CHESS_RULESET_ID = 'rapture-chess.v1';

export function defineChessTitle() {
  const rules = createChessRules();
  // The balance version pins the move encoding and the result rules; a change to either is a new ruleset id.
  const balance = { version: 'bal-chess-v1', apply: () => ({}) };
  return {
    manifest: {
      kind: 'replayable',
      rulesetId: CHESS_RULESET_ID,
      tickRate: 1,
      maxTicks: 1200,
      modes: ['ranked', 'casual', 'wager'],
      participants: 2,
      inputSchema: 'chess-move:op3,from6,to6,promo3',
      hiddenInfo: false,
      replicas: 3,
      standingFloor: 0,
      hostPolicy: { affinity: 'open' },
      exclusive: false,
      display: { title: 'Rapture Chess', url: 'https://rapture-chess.vercel.app', description: 'The Rapture ARC 1 champions play chess. Alliance is White, Horde is Black.', cover: null, accent: '#ffc455' },
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
    serialize: (s: ChessState): ChessState => JSON.parse(JSON.stringify(s)) as ChessState,
    view: (s: ChessState): ChessState => s,
  };
}
