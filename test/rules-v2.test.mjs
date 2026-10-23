// Rules v2: the clock in the log, flags (FIDE 6.9), draw offers, the move limit, and v1 behaviour for logs without
// any of it. Runs the TypeScript rules (node --import tsx) and the built ruleset artifact the nodes replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Chess } from 'chess.js';
import {
  createChessRules, encodeMove, encodeControl, encodeClock, concede, offerDraw, acceptDraw, declineDraw, cannotMate, entryAction, MAX_BEATS,
} from '../src/rules/chessRules.ts';

const rules = createChessRules();
const P = ['white-key', 'black-key'];
const SCHOLARS = [['e2', 'e4'], ['e7', 'e5'], ['f1', 'c4'], ['b8', 'c6'], ['d1', 'h5'], ['g8', 'f6'], ['h5', 'f7']];

/** Step one entry: `side` acts with `x`, the other slot carries `other` (a clock stamp, or 0). */
const step = (s, side, x, other = 0) => rules.step(s, { [P[side]]: x, [P[side ^ 1]]: other });
const timed = (base, inc) => step(rules.init('seed', P), 0, encodeControl(base, inc));

test('an untimed log plays exactly as v1: scholar\'s mate', () => {
  let s = rules.init('seed', P);
  SCHOLARS.forEach(([f, t], i) => { s = step(s, i % 2, encodeMove(f, t)); });
  assert.equal(s.over, true);
  assert.equal(s.winner, 0);
  assert.equal(s.reason, 'checkmate');
  assert.equal(s.tc, null);
  assert.deepEqual(rules.scores(s), { [P[0]]: 1, [P[1]]: 0 });
});

test('the time control is set by the first entry only', () => {
  const s = timed(180, 2);
  assert.deepEqual(s.tc, { base: 180_000, inc: 2_000 });
  assert.deepEqual(s.left, [180_000, 180_000]);
  assert.notEqual(s.last, 0);
  const late = step(step(rules.init('seed', P), 0, encodeMove('e2', 'e4')), 0, encodeControl(60, 0));
  assert.equal(late.tc, null);
  assert.equal(late.last, 0);
});

test('stamps charge the side to move, the increment follows each move', () => {
  let s = timed(60, 2);
  s = step(s, 0, encodeMove('e2', 'e4'), encodeClock(5_000));
  assert.deepEqual(s.left, [57_000, 60_000]);
  s = step(s, 1, encodeMove('e7', 'e5'), encodeClock(10_000));
  assert.deepEqual(s.left, [57_000, 52_000]);
  // an out-of-turn action (a draw offer by Black) carries White's elapsed time in White's slot
  s = rules.step(s, { [P[0]]: encodeClock(1_000), [P[1]]: offerDraw() });
  assert.deepEqual(s.left, [56_000, 52_000]);
  assert.equal(s.offer, 1);
});

test('a flag loses, and a move stamped past the flag does not count', () => {
  let s = timed(10, 0);
  s = step(s, 0, encodeMove('e2', 'e4'), encodeClock(1_000));
  s = step(s, 1, encodeMove('e7', 'e5'), encodeClock(10_000));
  assert.equal(s.over, true);
  assert.equal(s.winner, 0);
  assert.equal(s.reason, 'timeout');
  assert.equal(s.sans.length, 1);
  assert.deepEqual(s.left, [9_000, 0]);
  // a bare stamp (no action) flags too: the relay's timeout entry
  let t = timed(10, 0);
  t = rules.step(t, { [P[0]]: 0, [P[1]]: encodeClock(10_001) });
  assert.equal(t.winner, 1);
  assert.equal(t.reason, 'timeout');
});

test('FIDE 6.9: a flag against a side that cannot mate is a draw', () => {
  const pos = (fen) => new Chess(fen);
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/8/4K2Q w - - 0 1'), 1), true);          // Black: bare king
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/8/4K2Q w - - 0 1'), 0), false);         // White: a queen
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/8/2B1K3 w - - 0 1'), 0), true);         // K+B v K (dead)
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/8/1N2K3 w - - 0 1'), 0), true);         // K+N v K (dead)
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/4p3/1N2K3 w - - 0 1'), 0), false);      // K+N v K+P: a mate exists
  assert.equal(cannotMate(pos('8/8/8/4k3/8/4b3/8/2B1K3 w - - 0 1'), 0), true);       // same-colour bishops only
  assert.equal(cannotMate(pos('8/8/8/4k3/8/5b2/8/2B1K3 w - - 0 1'), 0), false);      // opposite colours: a mate exists
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/4r3/2B1K3 w - - 0 1'), 0), false);      // K+B v K+R: a mate exists
});

test('draw offers: accept, decline, decline by moving, crossing offers, the cooldown', () => {
  let s = rules.init('seed', P);
  s = step(s, 0, encodeMove('e2', 'e4'));
  s = step(s, 1, offerDraw());
  assert.equal(s.offer, 1);
  assert.equal(rules.canDraw(s, 1, offerDraw()), false);                // no second offer while one stands
  s = step(s, 1, offerDraw());
  assert.equal(s.last, 0);
  s = step(s, 1, encodeMove('e7', 'e5'));                               // Black moves: its own offer stands
  assert.equal(s.sans.length, 2);
  assert.equal(s.offer, 1);
  s = step(s, 0, encodeMove('g1', 'f3'));                               // White moves: declines
  assert.equal(s.offer, -1);
  s = step(s, 1, offerDraw());
  assert.equal(s.offer, 1);
  s = step(s, 0, declineDraw());
  assert.equal(s.offer, -1);
  assert.equal(rules.canDraw(s, 1, offerDraw()), false);                // cooldown: two plies
  s = step(s, 1, encodeMove('b8', 'c6'));
  s = step(s, 0, encodeMove('b1', 'c3'));
  assert.equal(rules.canDraw(s, 1, offerDraw()), true);
  s = step(s, 0, offerDraw());
  s = step(s, 1, offerDraw());                                          // an offer against a standing offer agrees
  assert.equal(s.over, true);
  assert.equal(s.winner, 2);
  assert.equal(s.reason, 'agreement');
  assert.deepEqual(rules.scores(s), { [P[0]]: 0.5, [P[1]]: 0.5 });
  let a = step(rules.init('seed', P), 0, offerDraw());
  assert.equal(step(a, 0, acceptDraw()).over, false);                   // you cannot accept your own offer
  a = step(a, 1, acceptDraw());
  assert.equal(a.reason, 'agreement');
  // the offering side keeps the offer when it moves
  let k = step(rules.init('seed', P), 0, offerDraw());
  k = step(k, 0, encodeMove('e2', 'e4'));
  assert.equal(k.offer, 0);
});

test('concession from either seat, two stamps are a no-op, entryAction finds the action', () => {
  const s = rules.init('seed', P);
  assert.equal(step(s, 1, concede()).winner, 0);
  assert.equal(rules.step(timed(60, 0), { [P[0]]: encodeClock(1), [P[1]]: encodeClock(1) }).last, 0);
  assert.equal(entryAction([encodeMove('e2', 'e4'), encodeClock(500)]), encodeMove('e2', 'e4'));
  assert.equal(entryAction([encodeClock(500), offerDraw()]), offerDraw());
  assert.equal(entryAction([0, encodeClock(500)]), 0);
});

test('the move limit ends the log drawn', () => {
  let s = rules.init('seed', P);
  for (let i = 0; i < MAX_BEATS; i++) s = rules.step(s, { [P[0]]: 0, [P[1]]: 0 });
  assert.equal(s.over, true);
  assert.equal(s.reason, 'move limit');
});

test('the built ruleset artifact replays a timed game to the same state', async (t) => {
  const url = new URL('../titles/rapture-chess.v2.mjs', import.meta.url);
  if (!existsSync(url)) return t.skip('run node scripts/build-title.mjs first');
  const title = (await import(url.href)).default;
  assert.equal(title.manifest.rulesetId, 'rapture-chess.v2');
  let a = title.init('seed', P), b = timed(60, 1);
  a = title.step(a, { [P[0]]: encodeControl(60, 1), [P[1]]: 0 });
  SCHOLARS.forEach(([f, to], i) => {
    const side = i % 2;
    const inputs = { [P[side]]: encodeMove(f, to), [P[side ^ 1]]: encodeClock(1_500) };
    a = title.step(a, inputs); b = rules.step(b, inputs);
  });
  assert.deepEqual(title.serialize(a), b);
  assert.equal(a.reason, 'checkmate');
  assert.deepEqual(a.left, [58_000, 58_500]);   // four and three moves at 1.5 s each, 1 s back per move
});
