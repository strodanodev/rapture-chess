/**
 * The per-match server a LitNode host spawns for Rapture Chess (node/gauntlet.js "gauntlet"), plug and play:
 *
 *   - the node places the match, mints one HMAC join ticket per placed player and proxies
 *     wss://<wsAddr>/<room> to this process (GAUNTLET_* in the environment);
 *   - this server seats the two players by ticket, sequences their actions into the input log
 *     ({ k, inputs: [alliance, horde] }, one entry per accepted action), keeps the clock,
 *     asks both players to sign the log at the end (their arcade shell signs the chain head) and posts the
 *     ledger to the node's /ledger;
 *   - the node and its witnesses replay that log through the pinned ruleset; nothing this server says about the
 *     result counts. The settled delta is what the LitNodeWager escrow pays on.
 *
 * Rulesets (GAUNTLET_RULESET, set by the node):
 *   rapture-chess.v2   the clock is in the log: the first entry sets the time control (CHESS_TC, default 5+3), every
 *                      later entry carries the time the side to move spent, stamped in the other player's slot, and a
 *                      flag is a bare stamp. Each side's first move is off the clock (CHESS_FIRST_MOVE_MS to make it,
 *                      or concede). Draw offers, acceptances and declines from either side.
 *   rapture-chess.v1   moves and concessions only, a flat CHESS_TURN_MS per move (the clock lives here, a timeout is
 *                      logged as a concession).
 *
 * Settlement never waits on the loser. Both signatures make an `attestation: "players"` ledger. When a player has
 * left or will not sign, the ledger goes out under this relay's own key (`relay`, accepted by a node whose RELAY_KEYS
 * lists it; the key comes from CHESS_RELAY_KEY or .relay-key.json, see scripts/relay-key.mjs), and casual matches
 * fall back to the host's word. Every signature that did arrive is broadcast with the result: the winner's own
 * ledger signature is what escrow v2 needs to pay a match the loser never signed.
 *
 * Dev mode (RELAY_DEV=1, no LitNode): rooms by name, players name themselves in `hello`, no ledger post.
 *   RELAY_DEV=1 pnpm relay      →  ws://127.0.0.1:7831   (open the game with ?relay=ws://127.0.0.1:7831&room=x&name=alice)
 *
 * Gauntlet config: gauntlets/rapture-chess.json (node.env: GAUNTLETS=rapture-chess.v2=<abs path>,…).
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign as edSign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createChessRules, type ChessState, concede, encodeClock, encodeControl, Op, type Side } from '../src/rules/chessRules';
import { CHESS_RULESET_ID, CHESS_RULESET_V1 } from '../src/litnode/chessTitle';
import { canonical } from '../src/web3/canonical';

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
const RULESET = env.GAUNTLET_RULESET || CHESS_RULESET_ID;
const LEGACY = RULESET === CHESS_RULESET_V1;
/** "<minutes>+<increment seconds>" (5+3, 3+2, 10+5), or "none" for an untimed v2 game. */
const TC = (() => {
  const m = /^(\d+(?:\.\d+)?)\+(\d+)$/.exec(env.CHESS_TC ?? '5+3');
  return LEGACY || !m ? null : { baseSec: Math.round(Number(m[1]) * 60), incSec: Number(m[2]) };
})();
const TURN_MS = Number(env.CHESS_TURN_MS ?? 60_000);
const FIRST_MOVE_MS = Number(env.CHESS_FIRST_MOVE_MS ?? 30_000);
const DISCONNECT_MS = Number(env.CHESS_DISCONNECT_MS ?? 60_000);
const SIGN_MS = Number(env.CHESS_SIGN_MS ?? 60_000);
const TTL_MS = Number(env.CHESS_TTL_MS ?? 30 * 60_000);
const seats: Array<{ sub: string }> = env.GAUNTLET_SEATS ? JSON.parse(env.GAUNTLET_SEATS) : [];
if (!DEV && (!SECRET || seats.length !== 2 || !MATCH_ID || !SEED)) throw new Error('gauntlet env missing: GAUNTLET_SECRET, GAUNTLET_SEATS (2 seats), GAUNTLET_MATCH_ID, GAUNTLET_SEED');

const rules = createChessRules();
// The node keeps only the last line of a gauntlet's output, so a placed match also logs to relay/logs/<matchId>.log.
const LOG_FILE = DEV || !MATCH_ID ? null : `relay/logs/${MATCH_ID.slice(0, 32)}.log`;
if (LOG_FILE) try { mkdirSync('relay/logs', { recursive: true }); } catch { /* read-only checkout: console only */ }
const log = (room: string, msg: string): void => {
  const line = `[chess ${room.slice(0, 12)}] ${msg}`;
  console.log(line);
  if (LOG_FILE) try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ }
};

// ------------------------------------------------------------------ the relay key (LitNode settle.js RELAY_TAG)
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const relayKey: { id: string; key: KeyObject } | null = (() => {
  const file = env.CHESS_RELAY_KEY_FILE ?? '.relay-key.json';
  const seed = env.CHESS_RELAY_KEY ?? (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { privateKey?: string }).privateKey : undefined);
  if (!seed || !/^[0-9a-f]{64}$/i.test(seed)) return null;
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' });
  const id = (createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
  return { id, key };
})();
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** LitNode protocol/log.js chainHead: h('tick', prev, { k, inputs }) from 'genesis'. */
const chainHead = (entries: Array<{ k: number; inputs: [number, number] }>): string =>
  entries.reduce((head, e) => sha256(`tick\0${head}\0${canonical({ k: e.k, inputs: e.inputs })}`), 'genesis');
const relaySign = (body: unknown): string => edSign(null, Buffer.from(`relay\0${canonical(body)}`, 'utf8'), relayKey!.key).toString('hex');

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
  /** When the last entry was stamped: the side to move's clock runs from here. */
  stampAt: number;
  deadline: number;
  turnTimer: ReturnType<typeof setTimeout> | null;
  ended: boolean;
  signing: boolean;
  delta: unknown;
}
const rooms = new Map<string, Room>();
const participantsOf = (r: Room): [string, string] => [r.seats[0]?.id ?? '', r.seats[1]?.id ?? ''];
const send = (ws: WebSocket | null, msg: unknown): void => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const broadcast = (r: Room, msg: unknown): void => { for (const s of r.seats) send(s.ws, msg); };
const signaturesOf = (r: Room): Record<string, string> => Object.fromEntries(r.seats.filter((s) => s.sig).map((s) => [s.id, s.sig as string]));
const timed = (r: Room): boolean => !!r.state?.tc;
/** Each side's first move is off the clock. */
const clockRunning = (r: Room): boolean => timed(r) && (r.state?.sans.length ?? 0) >= 2;
/** What the side to move has left right now, in ms. */
const remaining = (r: Room): number => {
  if (!r.state || r.state.over) return 0;
  if (!clockRunning(r)) return timed(r) ? Math.max(0, r.stampAt + FIRST_MOVE_MS - Date.now()) : Math.max(0, r.deadline - Date.now());
  return Math.max(0, r.state.left[r.state.turn] - (Date.now() - r.stampAt));
};
const clockMsg = (r: Room) => ({ turnMs: TURN_MS, remaining: remaining(r), deadline: r.deadline, firstMove: timed(r) && !clockRunning(r) });
const startMsg = (r: Room) => ({ t: 'start', matchId: r.matchId, rulesetId: RULESET, buildHash: BUILD, seed: r.seed, participants: participantsOf(r), entries: r.entries, tc: r.state?.tc ?? null, ...clockMsg(r) });

function room(id: string): Room {
  let r = rooms.get(id);
  if (!r) {
    // The gauntlet room is the placed match: its id, seed and seats come from the node. A dev room is named by its players.
    const gauntlet = !DEV;
    r = { id, matchId: gauntlet ? MATCH_ID : randomBytes(32).toString('hex'), seed: gauntlet ? SEED : randomBytes(32).toString('hex'), seats: gauntlet ? seats.map((s) => ({ id: s.sub, ws: null, sig: null, goneAt: null })) : [], entries: [], state: null, stampAt: 0, deadline: 0, turnTimer: null, ended: false, signing: false, delta: null };
    rooms.set(id, r);
  }
  return r;
}

/**
 * Append one entry: `side`'s word, and in a timed game the time the side to move spent since the last entry,
 * stamped in the other slot. Only entries the rules accept are logged (a rejected word costs no time). A word
 * stamped after the flag fell is accepted as the flag.
 */
function record(r: Room, side: Side, x: number, minSpent = 0): boolean {
  if (!r.state || r.state.over) return false;
  const inputs: [number, number] = [0, 0];
  inputs[side] = x | 0;
  if (timed(r)) inputs[side === 0 ? 1 : 0] = encodeClock(clockRunning(r) ? Math.max(minSpent, Date.now() - r.stampAt) : 0);
  const next = rules.step(r.state, { [r.state.p[0]]: inputs[0], [r.state.p[1]]: inputs[1] });
  if (!next.last) return false;
  const entry = { k: r.entries.length, inputs };
  r.entries.push(entry);
  r.state = next;
  r.stampAt = Date.now();
  armClock(r);
  broadcast(r, { t: 'entry', entry, ...clockMsg(r) });
  if (rules.done(r.state)) void finish(r);
  return true;
}

function armClock(r: Room): void {
  if (r.turnTimer) clearTimeout(r.turnTimer);
  r.turnTimer = null;
  if (!r.state || r.state.over) return;
  const side = r.state.turn;
  const sans = r.state.sans.length;
  if (clockRunning(r)) {
    // the flag: a bare stamp of everything the side to move had left
    const left = r.state.left[side];
    r.deadline = Date.now() + left;
    r.turnTimer = setTimeout(() => {
      if (r.state && !r.state.over && r.state.turn === side && r.state.sans.length === sans) { log(r.id, `flag: side ${side}`); record(r, side, 0, left); }
    }, left);
    return;
  }
  // v1, untimed v2, or a first move: a player who lets the window pass concedes, and both players sign that log
  const window = timed(r) ? FIRST_MOVE_MS : TURN_MS;
  r.deadline = Date.now() + window;
  r.turnTimer = setTimeout(() => {
    if (r.state && !r.state.over && r.state.turn === side && r.state.sans.length === sans) { log(r.id, `clock: side ${side} concedes`); record(r, side, concede()); }
  }, window);
}

function maybeStart(r: Room): void {
  if (r.state || r.seats.length !== 2 || r.seats.some((s) => !s.ws)) return;
  r.state = rules.init(r.seed, participantsOf(r));
  r.stampAt = Date.now();
  if (TC) {
    // the first entry sets the time control; both players sign it with the rest of the log
    const inputs: [number, number] = [encodeControl(TC.baseSec, TC.incSec), 0];
    r.state = rules.step(r.state, { [r.state.p[0]]: inputs[0], [r.state.p[1]]: inputs[1] });
    r.entries.push({ k: 0, inputs });
  }
  armClock(r);
  log(r.id, `start: ${r.seats.map((s) => s.id.slice(0, 8)).join(' vs ')} ${RULESET}${TC ? ` ${TC.baseSec / 60}+${TC.incSec}` : ''}`);
  broadcast(r, startMsg(r));
}

async function post(submission: Record<string, unknown>): Promise<{ ok: boolean; delta: { error?: string; attestation?: string; proof?: string } }> {
  const res = await fetch(`${NODE_URL.replace(/\/+$/, '')}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
  return { ok: res.ok, delta: await res.json() as { error?: string; attestation?: string; proof?: string } };
}

async function finish(r: Room): Promise<void> {
  if (r.ended || !r.state) return;
  r.ended = true;
  if (r.turnTimer) clearTimeout(r.turnTimer);
  const winner = r.state.winner;
  log(r.id, `over: ${['alliance', 'horde', 'draw'][winner] ?? winner} by ${r.state.reason} after ${r.entries.length} entries`);
  broadcast(r, { t: 'over', winner, reason: r.state.reason, ticks: r.entries.length });
  // Both players sign the chain head (their arcade shell recomputes it from the entries they recorded). A player who
  // has left is not waited for.
  r.signing = true;
  broadcast(r, { t: 'sign', matchId: r.matchId, buildHash: BUILD, ticks: r.entries.length });
  const t0 = Date.now();
  while (!DEV && NODE_URL && Date.now() - t0 < SIGN_MS && r.seats.some((s) => !s.sig && s.ws)) await new Promise((res) => setTimeout(res, 250));
  r.signing = false;
  if (DEV || !NODE_URL) { broadcast(r, { t: 'settled', delta: null, dev: true, seed: r.seed, entries: r.entries, signatures: signaturesOf(r) }); log(r.id, 'dev: not settling'); return; }
  const base = { matchId: r.matchId, rulesetId: RULESET, buildHash: BUILD, mode: MODE, participants: participantsOf(r), entries: r.entries };
  const signatures = signaturesOf(r);
  const attempts: Array<[string, Record<string, unknown>]> = [];
  if (Object.keys(signatures).length === 2) attempts.push(['players', { ...base, signatures }]);
  if (relayKey) {
    const body = { matchId: r.matchId, head: chainHead(r.entries), ticks: r.entries.length, expected: null };
    attempts.push(['relay', { ...base, relay: { id: relayKey.id, sig: relaySign(body) } }]);
  }
  if (MODE !== 'ranked') attempts.push(['host', base]);
  let settled = false, lastError = 'no way to settle: unsigned ranked match and no relay key';
  for (const [how, submission] of attempts) {
    try {
      const { ok, delta } = await post(submission);
      log(r.id, `ledger (${how}) ${ok ? `settled (${delta.attestation ?? '?'}, ${delta.proof ?? '?'})` : `refused: ${delta.error}`}`);
      if (!ok) { lastError = delta.error ?? 'refused'; continue; }
      r.delta = delta;
      broadcast(r, { t: 'settled', delta, seed: r.seed, entries: r.entries, signatures });
      settled = true;
      break;
    } catch (e) { lastError = `ledger: ${(e as Error).message}`; log(r.id, lastError); }
  }
  if (!settled) broadcast(r, { t: 'error', message: lastError });
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
    if (r.state) {
      send(c.ws, startMsg(r));
      if (r.signing && !s.sig) send(c.ws, { t: 'sign', matchId: r.matchId, buildHash: BUILD, ticks: r.entries.length });
      if (r.delta) send(c.ws, { t: 'settled', delta: r.delta, seed: r.seed, entries: r.entries, signatures: signaturesOf(r) });
    }
    else maybeStart(r);
    return;
  }
  const r = c.room, s = c.seat;
  if (!r || !s || !r.state) return;
  const side = r.seats.indexOf(s) as Side;
  if (m.t === 'act' && Number.isInteger(m.x)) {
    const x = (m.x as number) | 0, op = x & 7;
    if (op === Op.Concede) { record(r, side, concede()); return; }
    if (op === Op.Offer || op === Op.Accept || op === Op.Decline) {
      if (LEGACY) return send(c.ws, { t: 'reject', x, reason: `draw offers need ${CHESS_RULESET_ID}` });
      if (!rules.canDraw(r.state, side, x) || !record(r, side, op)) send(c.ws, { t: 'reject', x, reason: 'no draw offer to answer, or one was made too recently' });
      return;
    }
    if (op !== Op.Move) return send(c.ws, { t: 'reject', x, reason: 'not a player action' });
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
  if (view) return res.end(JSON.stringify({ matchId: view.matchId, rulesetId: RULESET, seated: view.seats.map((s) => !!s.ws), participants: participantsOf(view), entries: view.entries, state: view.state, over: view.state?.over ?? false, delta: view.delta }));
  res.end(JSON.stringify({ title: RULESET, mode: DEV ? 'dev' : 'gauntlet', matchId: DEV ? null : MATCH_ID, rooms: rooms.size, relayKey: relayKey?.id ?? null }));
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
    // A player who stays away concedes, so the match can still settle (the clock keeps running meanwhile).
    setTimeout(() => { if (!s.ws && r.state && !r.state.over) { log(r.id, `side ${r.seats.indexOf(s)} left: concedes`); record(r, r.seats.indexOf(s) as Side, concede()); } }, DISCONNECT_MS).unref();
  });
});
server.listen(PORT, HOST, () => console.log(`[chess relay] ${RULESET} on ${HOST}:${PORT} ${DEV ? '(dev rooms)' : `gauntlet match ${MATCH_ID.slice(0, 12)} mode ${MODE}`}, ${TC ? `clock ${TC.baseSec / 60}+${TC.incSec}` : `turn ${TURN_MS / 1000}s`}${relayKey ? `, relay key ${relayKey.id.slice(0, 12)}` : ''}`));
if (!DEV) setTimeout(() => process.exit(0), TTL_MS).unref();
