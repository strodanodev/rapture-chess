/**
 * The per-match server a LitNode host spawns for Rapture Chess (node/gauntlet.js "gauntlet"), plug and play:
 *
 *   - the node places the match, mints one HMAC join ticket per placed player and proxies
 *     wss://<wsAddr>/<room> to this process (GAUNTLET_* in the environment);
 *   - this server seats the two players by ticket, sequences their moves into the input log
 *     ({ k, inputs: [alliance, horde] }, one entry per accepted action), keeps the turn clock,
 *     asks both players to sign the log at the end (their arcade shell signs the chain head) and posts the
 *     signed ledger to the node's /ledger;
 *   - the node and its witnesses replay that log through the pinned ruleset (rulesets/rapture-chess.v1.js);
 *     nothing this server says about the result counts. The settled delta is what the LitNodeWager escrow pays on.
 *
 * Dev mode (RELAY_DEV=1, no LitNode): rooms by name, players name themselves in `hello`, no ledger post.
 *   RELAY_DEV=1 pnpm relay      →  ws://127.0.0.1:7831   (open the game with ?relay=ws://127.0.0.1:7831&room=x&name=alice)
 *
 * Gauntlet config: gauntlets/rapture-chess.json (node.env: GAUNTLETS=rapture-chess.v1=<abs path>, GAUNTLET_GATEWAY_PORT=8478).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createChessRules, type ChessState, concede, Op } from '../src/rules/chessRules';
import { CHESS_RULESET_ID } from '../src/litnode/chessTitle';

const env = process.env;
const DEV = env.RELAY_DEV === '1' || (!env.GAUNTLET_SECRET && !env.GAUNTLET_MATCH_ID);
const PORT = Number(env.GAUNTLET_PORT ?? env.PORT ?? 7831);
const HOST = env.RELAY_HOST ?? '127.0.0.1';
const SECRET = env.GAUNTLET_SECRET ?? '';
const MATCH_ID = env.GAUNTLET_MATCH_ID ?? '';
const SEED = env.GAUNTLET_SEED ?? '';
const NODE_URL = env.GAUNTLET_NODE_URL ?? '';
const BUILD = env.GAUNTLET_BUILD || null;
const MODE = env.GAUNTLET_PLACED_MODE ?? 'casual';
const TURN_MS = Number(env.CHESS_TURN_MS ?? 60_000);
const DISCONNECT_MS = Number(env.CHESS_DISCONNECT_MS ?? 60_000);
const SIGN_MS = Number(env.CHESS_SIGN_MS ?? 60_000);
const TTL_MS = Number(env.CHESS_TTL_MS ?? 30 * 60_000);
const seats: Array<{ sub: string }> = env.GAUNTLET_SEATS ? JSON.parse(env.GAUNTLET_SEATS) : [];
if (!DEV && (!SECRET || seats.length !== 2 || !MATCH_ID || !SEED)) throw new Error('gauntlet env missing: GAUNTLET_SECRET, GAUNTLET_SEATS (2 seats), GAUNTLET_MATCH_ID, GAUNTLET_SEED');

const rules = createChessRules();
const log = (room: string, msg: string): void => console.log(`[chess ${room.slice(0, 12)}] ${msg}`);

// ------------------------------------------------------------------ tickets (node/gauntlet.js mintTicket)
function verifyTicket(ticket: unknown): { sub: string; matchId: string; exp: number } | null {
  if (typeof ticket !== 'string' || !SECRET) return null;
  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  const want = Buffer.from(createHmac('sha256', SECRET).update(payload).digest('base64url'));
  const got = Buffer.from(ticket.slice(dot + 1));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.matchId === MATCH_ID && claims.exp > Date.now() ? claims : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ rooms
interface Seat { id: string; ws: WebSocket | null; sig: string | null; goneAt: number | null }
interface Room {
  id: string;            // the match id (gauntlet) or the room name (dev)
  matchId: string;
  seed: string;
  seats: Seat[];
  entries: Array<{ k: number; inputs: [number, number] }>;
  state: ChessState | null;
  deadline: number;
  turnTimer: ReturnType<typeof setTimeout> | null;
  ended: boolean;
  delta: unknown;
}
const rooms = new Map<string, Room>();
const participantsOf = (r: Room): [string, string] => [r.seats[0]?.id ?? '', r.seats[1]?.id ?? ''];
const send = (ws: WebSocket | null, msg: unknown): void => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const broadcast = (r: Room, msg: unknown): void => { for (const s of r.seats) send(s.ws, msg); };
const startMsg = (r: Room) => ({ t: 'start', matchId: r.matchId, rulesetId: CHESS_RULESET_ID, buildHash: BUILD, seed: r.seed, participants: participantsOf(r), entries: r.entries, turnMs: TURN_MS, deadline: r.deadline });

function room(id: string): Room {
  let r = rooms.get(id);
  if (!r) {
    // The gauntlet room is the placed match: its id, seed and seats come from the node. A dev room is named by its players.
    const gauntlet = !DEV;
    r = { id, matchId: gauntlet ? MATCH_ID : randomBytes(32).toString('hex'), seed: gauntlet ? SEED : randomBytes(32).toString('hex'), seats: gauntlet ? seats.map((s) => ({ id: s.sub, ws: null, sig: null, goneAt: null })) : [], entries: [], state: null, deadline: 0, turnTimer: null, ended: false, delta: null };
    rooms.set(id, r);
  }
  return r;
}

function record(r: Room, side: 0 | 1, x: number): void {
  if (!r.state || r.state.over) return;
  const inputs: [number, number] = side === 0 ? [x | 0, 0] : [0, x | 0];
  const next = rules.step(r.state, { [r.state.p[0]]: inputs[0], [r.state.p[1]]: inputs[1] });
  if (!next.last) return; // a no-op beat is not an entry: the log holds accepted actions only
  const entry = { k: r.entries.length, inputs };
  r.entries.push(entry);
  r.state = next;
  armClock(r);
  broadcast(r, { t: 'entry', entry, deadline: r.deadline });
  if (rules.done(r.state)) void finish(r);
}

function armClock(r: Room): void {
  if (r.turnTimer) clearTimeout(r.turnTimer);
  r.turnTimer = null;
  if (!r.state || r.state.over) return;
  r.deadline = Date.now() + TURN_MS;
  const side = r.state.turn;
  // A player who lets the clock run out concedes; the entry carries their concession and both players sign the log.
  r.turnTimer = setTimeout(() => { if (r.state && !r.state.over && r.state.turn === side) { log(r.id, `clock: side ${side} concedes`); record(r, side, concede()); } }, TURN_MS);
}

function maybeStart(r: Room): void {
  if (r.state || r.seats.length !== 2 || r.seats.some((s) => !s.ws)) return;
  r.state = rules.init(r.seed, participantsOf(r));
  armClock(r);
  log(r.id, `start: ${r.seats.map((s) => s.id.slice(0, 8)).join(' vs ')}`);
  broadcast(r, startMsg(r));
}

async function finish(r: Room): Promise<void> {
  if (r.ended || !r.state) return;
  r.ended = true;
  if (r.turnTimer) clearTimeout(r.turnTimer);
  const winner = r.state.winner;
  log(r.id, `over: ${['alliance', 'horde', 'draw'][winner] ?? winner} by ${r.state.reason} after ${r.entries.length} entries`);
  broadcast(r, { t: 'over', winner, reason: r.state.reason, ticks: r.entries.length });
  // Both players sign the chain head (their arcade shell recomputes it from the entries they recorded).
  broadcast(r, { t: 'sign', matchId: r.matchId, buildHash: BUILD, ticks: r.entries.length });
  const t0 = Date.now();
  while (!DEV && NODE_URL && Date.now() - t0 < SIGN_MS && r.seats.some((s) => !s.sig && s.ws)) await new Promise((res) => setTimeout(res, 250));
  if (DEV || !NODE_URL) { broadcast(r, { t: 'settled', delta: null, dev: true, seed: r.seed, entries: r.entries }); log(r.id, 'dev: not settling'); return; }
  const signatures = Object.fromEntries(r.seats.filter((s) => s.sig).map((s) => [s.id, s.sig]));
  const submission = { matchId: r.matchId, rulesetId: CHESS_RULESET_ID, buildHash: BUILD, mode: MODE, participants: participantsOf(r), entries: r.entries, signatures };
  try {
    const res = await fetch(`${NODE_URL.replace(/\/+$/, '')}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
    const delta = await res.json() as { error?: string; attestation?: string; proof?: string };
    log(r.id, `ledger ${res.status}: ${res.ok ? `settled (${delta.attestation ?? '?'}, ${delta.proof ?? '?'})` : delta.error}`);
    r.delta = res.ok ? delta : null;
    broadcast(r, res.ok ? { t: 'settled', delta, seed: r.seed, entries: r.entries } : { t: 'error', message: delta.error ?? `ledger ${res.status}` });
  } catch (e) {
    broadcast(r, { t: 'error', message: `ledger: ${(e as Error).message}` });
  }
  if (!DEV) setTimeout(() => process.exit(0), 5000).unref();
}

// ------------------------------------------------------------------ connections
function onMessage(c: { ws: WebSocket; room: Room | null; seat: Seat | null }, raw: string): void {
  let m: { t?: string; ticket?: string; player?: string; room?: string; x?: number; sig?: string };
  try { m = JSON.parse(raw); } catch { return; }
  if (m.t === 'hello') {
    let r: Room, id: string | undefined;
    if (DEV) {
      r = room(String(m.room ?? 'lobby'));
      id = typeof m.player === 'string' && m.player.length >= 1 && m.player.length <= 64 ? m.player : undefined;
      if (id && !r.seats.some((s) => s.id === id) && r.seats.length < 2 && !r.state) r.seats.push({ id, ws: null, sig: null, goneAt: null });
    } else {
      r = room(MATCH_ID);
      id = verifyTicket(m.ticket)?.sub;
    }
    const s = id ? r.seats.find((x) => x.id === id) : undefined;
    if (!s) { send(c.ws, { t: 'error', message: DEV ? 'room is full or the name is taken' : 'not a seat in this match (bad ticket)' }); return c.ws.close(); }
    s.ws?.close();
    s.ws = c.ws; s.goneAt = null;
    c.room = r; c.seat = s;
    send(c.ws, { t: 'seated', you: s.id, side: r.seats.indexOf(s), waiting: r.seats.filter((x) => !x.ws).length + (2 - r.seats.length) });
    if (r.state) { send(c.ws, startMsg(r)); if (r.delta) send(c.ws, { t: 'settled', delta: r.delta, seed: r.seed, entries: r.entries }); }
    else maybeStart(r);
    return;
  }
  const r = c.room, s = c.seat;
  if (!r || !s || !r.state) return;
  const side = r.seats.indexOf(s) as 0 | 1;
  if (m.t === 'act' && Number.isInteger(m.x)) {
    const x = (m.x as number) | 0;
    if ((x & 7) === Op.Concede) return record(r, side, concede());
    if (r.state.turn !== side) return send(c.ws, { t: 'reject', x, reason: 'not your turn' });
    if (!rules.isLegal(r.state, x)) return send(c.ws, { t: 'reject', x, reason: 'illegal' });
    record(r, side, x);
  } else if (m.t === 'sig' && typeof m.sig === 'string' && /^[0-9a-f]{128}$/.test(m.sig)) {
    s.sig = m.sig;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  const view = url.pathname.startsWith('/match/') ? rooms.get(decodeURIComponent(url.pathname.slice(7))) : null;
  if (view) return res.end(JSON.stringify({ matchId: view.matchId, rulesetId: CHESS_RULESET_ID, seated: view.seats.map((s) => !!s.ws), participants: participantsOf(view), entries: view.entries, state: view.state, over: view.state?.over ?? false, delta: view.delta }));
  res.end(JSON.stringify({ title: CHESS_RULESET_ID, mode: DEV ? 'dev' : 'gauntlet', matchId: DEV ? null : MATCH_ID, rooms: rooms.size }));
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  const c = { ws, room: null as Room | null, seat: null as Seat | null };
  ws.on('message', (data) => onMessage(c, String(data)));
  ws.on('close', () => {
    const { room: r, seat: s } = c;
    if (!r || !s || s.ws !== ws) return;
    s.ws = null; s.goneAt = Date.now();
    if (!r.state || r.state.over) return;
    broadcast(r, { t: 'away', side: r.seats.indexOf(s), graceMs: DISCONNECT_MS });
    // A player who stays away concedes, so the match can still settle.
    setTimeout(() => { if (!s.ws && r.state && !r.state.over) { log(r.id, `side ${r.seats.indexOf(s)} left: concedes`); record(r, r.seats.indexOf(s) as 0 | 1, concede()); } }, DISCONNECT_MS).unref();
  });
});
server.listen(PORT, HOST, () => console.log(`[chess relay] ${CHESS_RULESET_ID} on ${HOST}:${PORT} ${DEV ? '(dev rooms)' : `gauntlet match ${MATCH_ID.slice(0, 12)} mode ${MODE}`}, turn ${TURN_MS / 1000}s`));
if (!DEV) setTimeout(() => process.exit(0), TTL_MS).unref();
