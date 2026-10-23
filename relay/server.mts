/**
 * Rapture Chess relay: seats two wallets at a wagered match, sequences their moves into the Deckwright-style log
 * `{ k, inputs: [alliance, horde] }`, keeps the turn clock, and signs the EIP-712 settlement the ChessWager
 * escrow pays out on. Rooms are keyed by matchId (= keccak256(seed)); the creator proves the seat by revealing the
 * seed, the joiner by their wallet, and with RPC_URL + WAGER_ADDRESS set both are checked against the escrow.
 *
 *   pnpm relay                       # ws://127.0.0.1:7831, GET /match/<id>, GET /health
 *
 * Environment:
 *   RELAY_PORT=7831 RELAY_HOST=127.0.0.1   TURN_MS=60000 (per move)   DISCONNECT_MS=90000 (grace before conceding)
 *   RESOLVER_PRIVATE_KEY=0x…   the escrow's `resolver`; settlements are signed only when it is set
 *   WAGER_ADDRESS=0x…  CHAIN_ID=4441        the EIP-712 domain (verifyingContract, chainId)
 *   RPC_URL=https://…                      optional: seats are checked against the escrow (creator/joiner/status)
 *   RELAY_DEV=1                            no wallet signatures: `hello.address` is trusted (local testing only)
 *   GAUNTLET_SECRET / GAUNTLET_MATCH_ID    LitNode gauntlet mode: HMAC seat tickets instead of wallet challenges
 *
 * Protocol (JSON text frames):
 *   → hello {matchId, address, seed?, ticket?}   ← challenge {nonce}   → auth {address, sig}   ← seated {side, waiting}
 *   ← start {matchId, seed, participants, entries, turnMs, deadline}   → act {x}   ← entry {entry, deadline} | reject {x, reason}
 *   ← clock {side, deadline}   ← over {winner, reason}   ← settlement {matchId, winner, logHash, sig|null, seed, entries}
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Wallet, JsonRpcProvider, Contract, verifyMessage, isAddress, getAddress } from 'ethers';
import { WebSocketServer, type WebSocket } from 'ws';

import { createChessRules, concede, Op, type ChessState, type Side } from '../src/rules/chessRules';
import type { LogEntry } from '../src/game/session';
import { isBytes32, logHashOf, matchIdOf, settlementDomain, SETTLEMENT_TYPES, WAGER_ABI, type Winner } from '../src/web3/wager';

const env = process.env;
const PORT = Number(env.RELAY_PORT ?? env.PORT ?? 7831);
const HOST = env.RELAY_HOST ?? '127.0.0.1';
const TURN_MS = Number(env.TURN_MS ?? 60_000);
const DISCONNECT_MS = Number(env.DISCONNECT_MS ?? 90_000);
const ROOM_TTL_MS = Number(env.ROOM_TTL_MS ?? 6 * 60 * 60_000);
const DEV = env.RELAY_DEV === '1';
const CHAIN_ID = Number(env.CHAIN_ID ?? 4441);
const WAGER_ADDRESS = env.WAGER_ADDRESS && isAddress(env.WAGER_ADDRESS) ? getAddress(env.WAGER_ADDRESS) : null;
const resolver = env.RESOLVER_PRIVATE_KEY ? new Wallet(env.RESOLVER_PRIVATE_KEY) : null;
const provider = env.RPC_URL && WAGER_ADDRESS ? new JsonRpcProvider(env.RPC_URL, CHAIN_ID, { staticNetwork: true }) : null;
const escrow = provider ? new Contract(WAGER_ADDRESS!, WAGER_ABI as unknown as string[], provider) : null;
const GAUNTLET_SECRET = env.GAUNTLET_SECRET ?? '';
const GAUNTLET_MATCH_ID = env.GAUNTLET_MATCH_ID ?? '';

const rules = createChessRules();
const log = (room: string, msg: string): void => console.log(`[chess ${room.slice(2, 10)}] ${msg}`);
const seatMessage = (matchId: string, nonce: string): string => `Rapture Chess seat\nmatch: ${matchId}\nnonce: ${nonce}`;

// ------------------------------------------------------------------ rooms
interface Seat { address: string; ws: WebSocket | null; goneAt: number | null }
interface Room {
  matchId: string;
  seed: string | null;
  seats: [Seat | null, Seat | null];
  entries: LogEntry[];
  state: ChessState | null;
  deadline: number;
  turnTimer: ReturnType<typeof setTimeout> | null;
  settlement: { matchId: string; winner: Winner; logHash: string; sig: string | null } | null;
  reason: string;
  touched: number;
}
const rooms = new Map<string, Room>();
const participantsOf = (room: Room): [string, string] => [room.seats[0]?.address ?? 'alliance', room.seats[1]?.address ?? 'horde'];

function room(matchId: string): Room {
  let r = rooms.get(matchId);
  if (!r) {
    r = { matchId, seed: null, seats: [null, null], entries: [], state: null, deadline: 0, turnTimer: null, settlement: null, reason: '', touched: Date.now() };
    rooms.set(matchId, r);
  }
  r.touched = Date.now();
  return r;
}
const send = (ws: WebSocket | null, msg: unknown): void => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const broadcast = (r: Room, msg: unknown): void => { for (const s of r.seats) send(s?.ws ?? null, msg); };
const startMsg = (r: Room) => ({ t: 'start', matchId: r.matchId, seed: r.seed, participants: participantsOf(r), entries: r.entries, turnMs: TURN_MS, deadline: r.deadline });

function record(r: Room, side: Side, x: number): void {
  if (!r.state || r.state.over) return;
  const inputs: [number, number] = side === 0 ? [x | 0, 0] : [0, x | 0];
  const entry: LogEntry = { k: r.entries.length, inputs };
  const p = participantsOf(r);
  const next = rules.step(r.state, { [p[0]]: inputs[0], [p[1]]: inputs[1] });
  if (!next.last) return;                      // a no-op beat is not part of the log
  r.state = next;
  r.entries.push(entry);
  armClock(r);
  broadcast(r, { t: 'entry', entry, deadline: r.deadline });
  if (r.state.over) void finish(r);
}

function armClock(r: Room): void {
  if (r.turnTimer) clearTimeout(r.turnTimer);
  r.turnTimer = null;
  if (!r.state || r.state.over) return;
  const side = r.state.turn;
  r.deadline = Date.now() + TURN_MS;
  r.turnTimer = setTimeout(() => { r.reason = 'time'; record(r, side, concede()); }, TURN_MS);
  r.turnTimer.unref();
}

function maybeStart(r: Room): void {
  if (r.state || !r.seed || !r.seats[0]?.ws || !r.seats[1]?.ws) return;
  r.state = rules.init(r.seed, participantsOf(r));
  armClock(r);
  log(r.matchId, `start: ${r.seats[0].address} vs ${r.seats[1].address}`);
  broadcast(r, startMsg(r));
}

async function finish(r: Room): Promise<void> {
  if (!r.state || r.settlement || !r.seed) return;
  if (r.turnTimer) clearTimeout(r.turnTimer);
  const winner = r.state.winner as Winner;
  const logHash = logHashOf(r.seed, r.entries);
  let sig: string | null = null;
  if (resolver && WAGER_ADDRESS) {
    sig = await resolver.signTypedData(settlementDomain(WAGER_ADDRESS, CHAIN_ID), SETTLEMENT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>, { matchId: r.matchId, winner, logHash });
  }
  r.settlement = { matchId: r.matchId, winner, logHash, sig };
  log(r.matchId, `over: ${['alliance', 'horde', 'draw'][winner]} by ${r.state.reason}${sig ? ', settlement signed' : ' (unsigned: no resolver)'}`);
  broadcast(r, { t: 'over', winner, reason: r.state.reason });
  broadcast(r, { t: 'settlement', ...r.settlement, seed: r.seed, entries: r.entries });
}

// ------------------------------------------------------------------ seating
/** With an escrow configured, a seat must match the on-chain match: creator = side 0, joiner = side 1, and the match funded. */
async function escrowCheck(matchId: string, address: string, side: Side): Promise<string | null> {
  if (!escrow) return null;
  try {
    const m = await escrow.matches(matchId);
    const status = Number(m.status);
    if (status === 0) return 'no such match in the escrow';
    if (status > 2) return `match is ${['', 'open', 'live', 'settled', 'cancelled', 'timed out'][status]}`;
    const want = side === 0 ? String(m.creator) : String(m.joiner);
    if (side === 1 && status !== 2) return 'the Horde seat is not funded yet';
    if (getAddress(want) !== getAddress(address)) return 'this wallet is not in that seat';
    return null;
  } catch (e) {
    return `escrow read failed: ${(e as Error).message}`;
  }
}

/** node/gauntlet.js mintTicket: base64url(claims) '.' base64url(HMAC-SHA256(payload, secret)). */
function verifyTicket(ticket: unknown): { sub: string; matchId: string; exp: number } | null {
  if (typeof ticket !== 'string' || !GAUNTLET_SECRET) return null;
  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  const want = Buffer.from(createHmac('sha256', GAUNTLET_SECRET).update(payload).digest('base64url'));
  const got = Buffer.from(ticket.slice(dot + 1));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.matchId === GAUNTLET_MATCH_ID && claims.exp > Date.now() ? claims : null;
  } catch { return null; }
}

interface Conn { ws: WebSocket; matchId: string | null; address: string | null; seed: string | null; nonce: string | null; seat: Seat | null; room: Room | null }

async function seatPlayer(c: Conn): Promise<void> {
  const { matchId, address, seed } = c;
  if (!matchId || !address) return;
  const r = room(matchId);
  // the creator reveals the seed; the joiner takes the other seat
  let side: Side;
  if (seed) {
    if (!isBytes32(seed) || matchIdOf(seed) !== matchId) { send(c.ws, { t: 'error', message: 'seed does not match the match id' }); return c.ws.close(); }
    if (r.seed && r.seed !== seed) { send(c.ws, { t: 'error', message: 'another seed was already revealed for this match' }); return c.ws.close(); }
    side = 0;
  } else {
    const existing = r.seats.findIndex((s) => s && s.address.toLowerCase() === address.toLowerCase());
    side = existing >= 0 ? (existing as Side) : 1;
  }
  const problem = await escrowCheck(matchId, address, side);
  if (problem) { send(c.ws, { t: 'error', message: problem }); return c.ws.close(); }
  const taken = r.seats[side];
  if (taken && taken.address.toLowerCase() !== address.toLowerCase()) { send(c.ws, { t: 'error', message: 'that seat is taken' }); return c.ws.close(); }
  if (seed) r.seed = seed;
  const seat: Seat = taken ?? { address, ws: null, goneAt: null };
  if (seat.ws && seat.ws !== c.ws) seat.ws.close();
  seat.ws = c.ws; seat.goneAt = null;
  r.seats[side] = seat;
  c.seat = seat; c.room = r;
  send(c.ws, { t: 'seated', side, waiting: r.seats.filter((s) => !s?.ws).length });
  if (r.state) { send(c.ws, startMsg(r)); if (r.settlement) send(c.ws, { t: 'settlement', ...r.settlement, seed: r.seed, entries: r.entries }); }
  else maybeStart(r);
}

function onMessage(c: Conn, raw: string): void {
  let m: { t?: string; matchId?: string; address?: string; seed?: string; ticket?: string; sig?: string; x?: number };
  try { m = JSON.parse(raw); } catch { return; }
  if (m.t === 'hello') {
    if (!isBytes32(m.matchId)) { send(c.ws, { t: 'error', message: 'hello needs a bytes32 matchId' }); return c.ws.close(); }
    c.matchId = m.matchId;
    c.seed = typeof m.seed === 'string' ? m.seed : null;
    if (GAUNTLET_SECRET) {                                   // LitNode placed the match: the ticket is the seat proof
      const claims = verifyTicket(m.ticket);
      if (!claims) { send(c.ws, { t: 'error', message: 'bad ticket' }); return c.ws.close(); }
      c.address = claims.sub;
      return void seatPlayer(c);
    }
    if (DEV) {
      c.address = String(m.address ?? '').trim() || `guest-${randomBytes(3).toString('hex')}`;
      return void seatPlayer(c);
    }
    if (!isAddress(m.address)) { send(c.ws, { t: 'error', message: 'hello needs a wallet address' }); return c.ws.close(); }
    c.address = getAddress(m.address);
    c.nonce = randomBytes(16).toString('hex');
    return send(c.ws, { t: 'challenge', nonce: c.nonce, message: seatMessage(c.matchId, c.nonce) });
  }
  if (m.t === 'auth') {
    if (!c.matchId || !c.nonce || !c.address || typeof m.sig !== 'string') return;
    let signer: string | null = null;
    try { signer = verifyMessage(seatMessage(c.matchId, c.nonce), m.sig); } catch { signer = null; }
    if (!signer || getAddress(signer) !== c.address) { send(c.ws, { t: 'error', message: 'seat signature does not match the wallet' }); return c.ws.close(); }
    c.nonce = null;
    return void seatPlayer(c);
  }
  if (!c.seat || !c.room?.state) return;
  const r = c.room;
  const side = r.seats.indexOf(c.seat) as Side;
  if (m.t === 'act' && Number.isInteger(m.x)) {
    const x = (m.x as number) | 0;
    if ((x & 7) === Op.Concede) { r.reason = 'concession'; return record(r, side, concede()); }
    if (r.state!.turn === side && rules.isLegal(r.state!, x)) return record(r, side, x);
    return send(c.ws, { t: 'reject', x, reason: r.state!.turn === side ? 'illegal' : 'not your turn' });
  }
}

// ------------------------------------------------------------------ server
const http = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://relay');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  const m = /^\/match\/(0x[0-9a-fA-F]{64})$/.exec(url.pathname);
  if (m) {
    const r = rooms.get(m[1]);
    if (!r) { res.writeHead(404); return res.end(JSON.stringify({ error: 'no such match' })); }
    return res.end(JSON.stringify({ matchId: r.matchId, seed: r.state ? r.seed : null, participants: participantsOf(r), seated: r.seats.map((s) => !!s?.ws), entries: r.entries, state: r.state, deadline: r.deadline, settlement: r.settlement }));
  }
  res.end(JSON.stringify({ ok: true, rooms: rooms.size, resolver: resolver?.address ?? null, escrow: WAGER_ADDRESS, chainId: CHAIN_ID, dev: DEV, turnMs: TURN_MS }));
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
http.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const c: Conn = { ws, matchId: null, address: null, seed: null, nonce: null, seat: null, room: null };
    const fromPath = /^\/(0x[0-9a-fA-F]{64})/.exec(req.url ?? '');
    if (fromPath) c.matchId = fromPath[1];
    ws.on('message', (data) => onMessage(c, data.toString()));
    ws.on('close', () => {
      const { seat, room: r } = c;
      if (!seat || !r || seat.ws !== ws) return;
      seat.ws = null; seat.goneAt = Date.now();
      broadcast(r, { t: 'away', side: r.seats.indexOf(seat), graceMs: DISCONNECT_MS });
      // a player who stays away concedes, so the escrow can still settle
      setTimeout(() => { if (!seat.ws && r.state && !r.state.over) { r.reason = 'disconnect'; record(r, r.seats.indexOf(seat) as Side, concede()); } }, DISCONNECT_MS).unref();
    });
    ws.on('error', () => ws.close());
  });
});
setInterval(() => { const now = Date.now(); for (const [id, r] of rooms) if (now - r.touched > ROOM_TTL_MS && r.seats.every((s) => !s?.ws)) rooms.delete(id); }, 60_000).unref();

http.listen(PORT, HOST, () => {
  console.log(`[chess relay] ws://${HOST}:${PORT} turn ${TURN_MS / 1000}s${DEV ? ' DEV (unsigned seats)' : ''}${resolver ? ` resolver ${resolver.address}` : ' no resolver: settlements unsigned'}${escrow ? ` escrow ${WAGER_ADDRESS}` : ''}`);
});
