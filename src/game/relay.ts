/**
 * A relayed two-player match (wagered or friendly): the relay seats both wallets, orders the moves and signs the
 * settlement. This client applies only the entries the relay echoes back, so both boards and the relay replay the
 * same log; `poke()` is a no-op because the relay pushes the opponent's moves.
 */
import type { Move } from 'chess.js';
import type { Wallet } from 'deckwright/web/lib/wallet.js';
import { createChessRules, type ChessRules, type ChessState, concede, Op, type Side } from '../rules/chessRules';
import type { LogEntry, Match, MatchEvents } from './session';
import type { Winner } from '../web3/wager';

export interface RelaySettlement {
  matchId: string;
  winner: Winner;
  logHash: string;
  /** The resolver's EIP-712 signature, or null when the relay has no resolver key. */
  sig: string | null;
  seed: string;
  entries: LogEntry[];
}
export interface RelayClock { side: Side; deadline: number; turnMs: number }

export interface RelayMatchOptions {
  /** ws:// or wss:// relay origin, e.g. ws://127.0.0.1:7831 */
  url: string;
  matchId: string;
  side: Side;
  /** The creator (side 0) reveals the seed that hashes to the match id. */
  seed?: string;
  wallet: Wallet;
  events: MatchEvents;
  /** Dev relays (RELAY_DEV=1) accept a name instead of a wallet signature. */
  name?: string;
}

export class RelayMatch implements Match {
  public readonly rules: ChessRules = createChessRules();
  public state: ChessState;
  public readonly log: LogEntry[] = [];
  public seed = '';
  public participants: [string, string] = ['alliance', 'horde'];
  public settlement: RelaySettlement | null = null;
  public clock: RelayClock | null = null;
  private ws: WebSocket | null = null;
  private started = false;
  private closed = false;
  private readonly settlementListeners: Array<(s: RelaySettlement) => void> = [];
  private readonly clockListeners: Array<(c: RelayClock) => void> = [];
  private readonly events: MatchEvents;
  public readonly you: Side;
  public readonly matchId: string;

  constructor(private readonly opts: RelayMatchOptions) {
    this.you = opts.side;
    this.matchId = opts.matchId;
    this.events = opts.events;
    this.state = this.rules.init('pending', this.participants);
    this.open();
  }

  get yourTurn(): boolean { return this.started && !this.state.over && this.state.turn === this.you; }

  legalMoves(): Move[] {
    if (!this.started) return [];
    return this.rules.legalActions(this.state).map((x) => this.rules.resolve(this.state, x)!).filter(Boolean);
  }

  act(action: number): boolean {
    if (!this.started || this.closed) return false;
    if ((action & 7) !== Op.Concede && (!this.yourTurn || !this.rules.isLegal(this.state, action))) return false;
    this.ws?.send(JSON.stringify({ t: 'act', x: action | 0 }));
    return true;
  }
  concede(): void { this.act(concede()); }
  poke(): void { /* the relay pushes the opponent's entries */ }
  close(): void { this.closed = true; this.ws?.close(); this.ws = null; }

  onSettlement(cb: (s: RelaySettlement) => void): void { this.settlementListeners.push(cb); if (this.settlement) cb(this.settlement); }
  onClock(cb: (c: RelayClock) => void): void { this.clockListeners.push(cb); }

  // ------------------------------------------------------------------ transport
  private open(): void {
    const base = this.opts.url.replace(/\/+$/, '');
    const ws = new WebSocket(`${base}/${this.matchId}`);
    this.ws = ws;
    this.events.onStatus('connecting to the relay…');
    ws.onopen = () => {
      const address = this.opts.wallet.snapshot().address;
      ws.send(JSON.stringify({ t: 'hello', matchId: this.matchId, address: address ?? this.opts.name ?? '', seed: this.opts.seed }));
    };
    ws.onclose = () => { if (!this.closed) this.events.onStatus(this.state.over ? 'match over' : 'disconnected from the relay'); };
    ws.onerror = () => this.events.onStatus('relay connection failed');
    ws.onmessage = (ev) => { void this.onServer(JSON.parse(String(ev.data))); };
  }

  private async onServer(m: { t: string; [k: string]: unknown }): Promise<void> {
    switch (m.t) {
      case 'challenge': {
        this.events.onStatus('sign the seat in your wallet…');
        try {
          const sig = await this.opts.wallet.personalSign(String(m.message));
          this.ws?.send(JSON.stringify({ t: 'auth', address: this.opts.wallet.snapshot().address, sig }));
        } catch (e) { this.events.onStatus(`seat not signed: ${(e as Error).message}`); }
        break;
      }
      case 'seated':
        this.events.onStatus(Number(m.waiting) > 0 ? 'seated, waiting for the opponent…' : 'both seated, starting…');
        break;
      case 'start': {
        if (this.started) break;
        this.seed = String(m.seed);
        this.participants = m.participants as [string, string];
        this.state = this.rules.init(this.seed, this.participants);
        this.started = true;
        for (const e of (m.entries as LogEntry[]) ?? []) this.apply(e, false);
        this.setClock(Number(m.deadline), Number(m.turnMs));
        this.events.onStatus(this.yourTurn ? 'your move' : 'live: opponent to move');
        break;
      }
      case 'entry':
        this.apply(m.entry as LogEntry, true);
        this.setClock(Number(m.deadline), this.clock?.turnMs ?? 60_000);
        break;
      case 'clock':
        this.setClock(Number(m.deadline), Number(m.turnMs ?? this.clock?.turnMs ?? 60_000));
        break;
      case 'reject':
        this.events.onStatus(`move rejected: ${String(m.reason)}`);
        break;
      case 'away':
        this.events.onStatus(`opponent disconnected; they concede in ${Math.round(Number(m.graceMs) / 1000)} s unless they return`);
        break;
      case 'over':
        break;
      case 'settlement': {
        const s: RelaySettlement = { matchId: String(m.matchId), winner: Number(m.winner) as Winner, logHash: String(m.logHash), sig: (m.sig as string | null) ?? null, seed: String(m.seed), entries: (m.entries as LogEntry[]) ?? [] };
        this.settlement = s;
        for (const cb of this.settlementListeners) cb(s);
        break;
      }
      case 'error':
        this.events.onStatus(`relay: ${String(m.message)}`);
        break;
    }
  }

  private apply(entry: LogEntry, notify: boolean): void {
    if (entry.k !== this.log.length) return;   // out of order: the start replay covers it
    const x = entry.inputs[0] || entry.inputs[1];
    const move = this.rules.resolve(this.state, x);
    this.state = this.rules.step(this.state, { [this.participants[0]]: entry.inputs[0], [this.participants[1]]: entry.inputs[1] });
    this.log.push(entry);
    if (notify) this.events.onStep(entry, move, this.state);
  }

  private setClock(deadline: number, turnMs: number): void {
    if (!Number.isFinite(deadline) || this.state.over) return;
    this.clock = { side: this.state.turn, deadline, turnMs };
    for (const cb of this.clockListeners) cb(this.clock);
  }
}
