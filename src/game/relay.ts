/**
 * A two-player match over the gauntlet relay. Two ways in:
 *
 *   placed   the LitNode arcade launched this page for a match the mesh placed (`?match=&ws=&room=&player=`):
 *            the cabinet shell signs the seat challenge and, at the end, the match ledger; the relay posts the
 *            signed ledger to the node and the node's replay is the result (RelayMatch.placed);
 *   dev      a relay started with RELAY_DEV=1, rooms by name (`?relay=ws://127.0.0.1:7831&room=x&name=alice`).
 *
 * The relay echoes accepted entries; only those move the board, so both screens replay the same log.
 */
import type { Move } from 'chess.js';
import { connectShell, parseLaunch, type CabinetShell } from 'deckwright/src/client/shell.ts';
import { createChessRules, type ChessRules, type ChessState, concede, Op, type Side } from '../rules/chessRules';
import type { LogEntry, Match, MatchEvents } from './session';

export interface RelayClock { side: Side; deadline: number; turnMs: number }
/** What the relay reports once the node settled (placed matches) or the game ended (dev). */
export interface RelaySettled { matchId: string; delta: Record<string, unknown> | null; seed: string; entries: LogEntry[]; dev: boolean }

export class RelayMatch implements Match {
  public readonly rules: ChessRules = createChessRules();
  public state: ChessState;
  public readonly log: LogEntry[] = [];
  public seed = '';
  public participants: [string, string] = ['alliance', 'horde'];
  public you: Side = 0;
  public matchId = '';
  public buildHash: string | null = null;
  public settled: RelaySettled | null = null;
  public clock: RelayClock | null = null;
  private ws: WebSocket | null = null;
  private started = false;
  private closed = false;
  private readonly settledListeners: Array<(s: RelaySettled) => void> = [];
  private readonly clockListeners: Array<(c: RelayClock) => void> = [];

  private constructor(private readonly events: MatchEvents, public readonly playerId: string, private readonly shell: CabinetShell | null) {
    this.state = this.rules.init('pending', this.participants);
  }

  /** The placed match this page was launched for, seated through the arcade shell. */
  static async placed(events: MatchEvents): Promise<RelayMatch> {
    const launch = parseLaunch();
    const shell = await connectShell();
    const you = shell.init.player.id;
    const m = new RelayMatch(events, you, shell);
    const wsAddr = launch.ws ?? shell.init.match?.wsAddr ?? null;
    const room = launch.room ?? (launch.matchId ? `LIT-${launch.matchId.slice(0, 32).toUpperCase()}` : null);
    if (!wsAddr || !room) throw new Error('no relay in the launch: open this game from the LitNode arcade');
    m.matchId = launch.matchId ?? shell.init.match?.matchId ?? '';
    m.buildHash = launch.buildHash ?? shell.init.match?.buildHash ?? null;
    events.onStatus('claiming your seat…');
    const base = `${wsAddr.replace(/^ws/, 'http').replace(/\/+$/, '')}/${room}/ticket?player=${encodeURIComponent(you)}`;
    // First ask returns a one-time nonce (401); the second carries the player key's signature over it.
    const first = await fetch(base).then((r) => r.json()) as { challenge?: { matchId: string; room: string; player: string; nonce: string }; error?: string };
    if (!first.challenge) throw new Error(first.error ?? 'seat: no challenge');
    const sig = await shell.signSeat(first.challenge);
    const seat = await fetch(`${base}&nonce=${first.challenge.nonce}&sig=${sig}`).then((r) => r.json()) as { ticket?: string; ws?: string; error?: string };
    if (!seat.ticket || !seat.ws) throw new Error(seat.error ?? 'seat: no ticket');
    m.open(seat.ws, { t: 'hello', ticket: seat.ticket });
    return m;
  }

  /** A dev relay room: `url` is the relay origin, players name themselves. */
  static dev(events: MatchEvents, url: string, room: string, name: string): RelayMatch {
    const m = new RelayMatch(events, name, null);
    m.open(url.replace(/\/+$/, ''), { t: 'hello', room, player: name });
    return m;
  }

  get yourTurn(): boolean { return this.started && !this.state.over && this.state.turn === this.you; }
  get nodeUrl(): string | null { return this.shell?.init.node?.url ?? null; }

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
  close(): void { this.closed = true; this.ws?.close(); this.ws = null; this.shell?.close(); }
  /** Tell the arcade the match was played (it closes the title). */
  played(): void { this.shell?.exit(); }

  onSettled(cb: (s: RelaySettled) => void): void { this.settledListeners.push(cb); if (this.settled) cb(this.settled); }
  onClock(cb: (c: RelayClock) => void): void { this.clockListeners.push(cb); }

  // ------------------------------------------------------------------ transport
  private open(url: string, hello: Record<string, unknown>): void {
    const ws = new WebSocket(url);
    this.ws = ws;
    this.events.onStatus('connecting to the match…');
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onclose = () => { if (!this.closed) this.events.onStatus(this.state.over ? 'match over' : 'disconnected from the relay'); };
    ws.onerror = () => this.events.onStatus('relay connection failed');
    ws.onmessage = (ev) => { void this.onServer(JSON.parse(String(ev.data))); };
  }

  private async onServer(m: { t: string; [k: string]: unknown }): Promise<void> {
    switch (m.t) {
      case 'seated':
        this.you = (Number(m.side) === 1 ? 1 : 0);
        this.events.onStatus(Number(m.waiting) > 0 ? 'seated, waiting for the opponent…' : 'both seated, starting…');
        break;
      case 'start': {
        if (this.started) break;
        this.seed = String(m.seed);
        this.matchId = String(m.matchId);
        this.buildHash = (m.buildHash as string | null) ?? this.buildHash;
        this.participants = m.participants as [string, string];
        this.you = this.participants[1] === this.playerId ? 1 : 0;
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
      case 'reject':
        this.events.onStatus(`move rejected: ${String(m.reason)}`);
        break;
      case 'away':
        this.events.onStatus(`opponent disconnected; they concede in ${Math.round(Number(m.graceMs) / 1000)} s unless they return`);
        break;
      case 'sign': {
        // Sign the log THIS client recorded; the arcade shell recomputes the chain head from it.
        if (!this.shell) { this.events.onStatus('match over (dev relay: unsigned)'); break; }
        this.events.onStatus('signing the match ledger…');
        try {
          const sig = await this.shell.signLedger(String(m.matchId), (m.buildHash as string | null) ?? null, this.log);
          this.ws?.send(JSON.stringify({ t: 'sig', sig }));
          this.events.onStatus('settling on LitNode…');
        } catch (e) { this.events.onStatus(`not signed: ${(e as Error).message}`); }
        break;
      }
      case 'settled': {
        const s: RelaySettled = { matchId: this.matchId, delta: (m.delta as Record<string, unknown> | null) ?? null, seed: String(m.seed ?? this.seed), entries: (m.entries as LogEntry[]) ?? this.log, dev: !!m.dev };
        this.settled = s;
        const d = s.delta as { attestation?: string; proof?: string; placed?: boolean } | null;
        this.events.onStatus(d ? `settled on LitNode: ${d.proof ?? d.attestation ?? 'recorded'}${d.placed === false ? ' (unplaced, casual)' : ''}` : 'match over');
        for (const cb of this.settledListeners) cb(s);
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
