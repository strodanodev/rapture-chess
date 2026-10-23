/**
 * A local match: you against the worker bot, recorded as a Deckwright-style log of `{ k, inputs: [side0, side1] }`
 * entries, so the whole game can be replayed from the seed and the log alone.
 */
import { createChessRules, type ChessRules, type ChessState, concede, Op, type Side } from '../rules/chessRules';
import type { Move } from 'chess.js';

export interface LogEntry { k: number; inputs: [number, number] }

export interface MatchEvents {
  /** A log entry was accepted: the move it made (null for a concession / no-op) and the state after it. */
  onStep(entry: LogEntry, move: Move | null, state: ChessState): void;
  onStatus(text: string): void;
}

export class LocalMatch {
  public readonly rules: ChessRules = createChessRules();
  public state: ChessState;
  public readonly log: LogEntry[] = [];
  public readonly participants: [string, string];
  private worker: Worker | null = null;
  private pending = 0;
  private closed = false;

  constructor(public readonly seed: string, public readonly you: Side, private readonly events: MatchEvents, private readonly botBudgetMs = 1100) {
    this.participants = ['alliance', 'horde'];
    this.state = this.rules.init(seed, this.participants);
  }

  get yourTurn(): boolean { return !this.state.over && this.state.turn === this.you; }

  /** Legal chess.js moves for the side to act. */
  legalMoves(): Move[] {
    return this.rules.legalActions(this.state).map((x) => this.rules.resolve(this.state, x)!).filter(Boolean);
  }

  /** Your action; rejected unless it is your turn and legal. */
  act(action: number): boolean {
    if (!this.yourTurn && (action & 7) !== Op.Concede) return false;
    if ((action & 7) === Op.Move && !this.rules.isLegal(this.state, action)) return false;
    this.record(this.you, action);
    return true;
  }

  concede(): void { this.act(concede()); }

  /** Ask the bot for the opponent's move when it is to act. */
  poke(): void {
    if (this.closed || this.state.over || this.state.turn === this.you) return;
    this.events.onStatus('The Horde is thinking…');
    const id = ++this.pending;
    const w = this.worker ?? (this.worker = new Worker(new URL('./bot.worker.ts', import.meta.url), { type: 'module' }));
    w.onmessage = (ev: MessageEvent<{ id: number; action: number }>) => {
      if (ev.data.id !== id || this.closed) return;
      const side = this.you === 0 ? 1 : 0;
      this.record(side, ev.data.action);
    };
    w.postMessage({ id, fen: this.state.fen, budgetMs: this.botBudgetMs });
  }

  private record(side: Side, action: number): void {
    const inputs: [number, number] = side === 0 ? [action | 0, 0] : [0, action | 0];
    const entry: LogEntry = { k: this.log.length, inputs };
    const move = this.rules.resolve(this.state, action);
    this.state = this.rules.step(this.state, { [this.participants[0]]: inputs[0], [this.participants[1]]: inputs[1] });
    if (!this.state.last) return; // a no-op beat is not recorded (the relay drops those too)
    this.log.push(entry);
    this.events.onStep(entry, move, this.state);
  }

  close(): void { this.closed = true; this.worker?.terminate(); this.worker = null; }
}
