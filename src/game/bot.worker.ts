/**
 * The practice opponent: iterative-deepening alpha-beta over chess.js with a quiescence search on captures,
 * material + piece-square evaluation, inside a time budget. Runs in a worker so the board never stutters.
 * Deterministic for a given position and budget order (no randomness), so a replayed log stays a replay.
 */
import { Chess, type Move } from 'chess.js';
import { encodeMove } from '../rules/chessRules';

const VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
// piece-square tables from White's point of view, a8 first (index 0) to h1 (index 63)
const PST: Record<string, number[]> = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
};

function evaluate(c: Chess): number {
  let score = 0;
  const board = c.board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = board[r][f];
    if (!p) continue;
    const idx = p.color === 'w' ? r * 8 + f : (7 - r) * 8 + f;
    const v = VALUE[p.type] + PST[p.type][idx];
    score += p.color === 'w' ? v : -v;
  }
  return c.turn() === 'w' ? score : -score;
}

const order = (moves: Move[]): Move[] => moves.sort((a, b) => gain(b) - gain(a));
const gain = (m: Move): number => (m.captured ? 10 * VALUE[m.captured] - VALUE[m.piece] : 0) + (m.promotion ? 800 : 0);

let deadline = 0;
let nodes = 0;
class Timeout extends Error {}

function quiesce(c: Chess, alpha: number, beta: number, depth: number): number {
  const stand = evaluate(c);
  if (stand >= beta) return beta;
  if (alpha < stand) alpha = stand;
  if (depth <= 0) return alpha;
  for (const m of order(c.moves({ verbose: true }).filter((m) => m.captured))) {
    c.move(m);
    const s = -quiesce(c, -beta, -alpha, depth - 1);
    c.undo();
    if (s >= beta) return beta;
    if (s > alpha) alpha = s;
  }
  return alpha;
}

function search(c: Chess, depth: number, alpha: number, beta: number): number {
  if ((++nodes & 1023) === 0 && performance.now() > deadline) throw new Timeout();
  if (c.isCheckmate()) return -100000 - depth;
  if (c.isDraw()) return 0;
  if (depth <= 0) return quiesce(c, alpha, beta, 4);
  let best = -Infinity;
  for (const m of order(c.moves({ verbose: true }))) {
    c.move(m);
    const s = -search(c, depth - 1, -beta, -alpha);
    c.undo();
    if (s > best) best = s;
    if (s > alpha) alpha = s;
    if (alpha >= beta) break;
  }
  return best;
}

function think(fen: string, budgetMs: number, maxDepth = 6): Move | null {
  const c = new Chess(fen);
  const moves = order(c.moves({ verbose: true }));
  if (!moves.length) return null;
  deadline = performance.now() + budgetMs;
  nodes = 0;
  let best = moves[0];
  for (let depth = 1; depth <= maxDepth; depth++) {
    let bestAtDepth = best, bestScore = -Infinity;
    try {
      // the previous best first: a cut-off early makes the deeper pass cheap
      const ordered = [best, ...moves.filter((m) => m !== best)];
      for (const m of ordered) {
        c.move(m);
        const s = -search(c, depth - 1, -Infinity, -bestScore === Infinity ? Infinity : -bestScore);
        c.undo();
        if (s > bestScore) { bestScore = s; bestAtDepth = m; }
      }
    } catch (e) {
      if (e instanceof Timeout) break;
      throw e;
    }
    best = bestAtDepth;
    if (bestScore > 90000) break;
  }
  return best;
}

self.onmessage = (ev: MessageEvent<{ id: number; fen: string; budgetMs: number; maxDepth?: number }>) => {
  const { id, fen, budgetMs, maxDepth } = ev.data;
  const m = think(fen, budgetMs, maxDepth);
  self.postMessage({ id, action: m ? encodeMove(m.from, m.to, m.promotion ?? '') : 0, nodes });
};
