/**
 * Ranked play from the game itself, no arcade in between. This page holds the player's LitNode key (ed25519, in this
 * origin's storage, as the arcade keeps its own), finds the mesh in NodeDirectory on chain, queues, and verifies the
 * placement the way the arcade does: the host must be the one the placement rule produces from a snapshot rebuilt
 * from signed heartbeats, and the beacon must be the chain block it names. The seat challenge and the match ledger
 * are signed here by a CabinetShell of our own, under the same checks the arcade applies before it signs.
 *
 * The protocol code is LitNode's own (src/litnode/mesh, vendored by scripts/vendor-litnode.mjs).
 */
import type { CabinetShell, LaunchParams, SeatChallenge } from 'tessaract/src/client/shell.ts';
import type { ChainClient } from 'tessaract/web/lib/chain.js';
import { createClient, loadPlayer } from './mesh/client.js';
import { checkChallenge, newNonce, NONCE_RE, signSeat } from './mesh/protocol/challenge.js';
import { decodeEntry, entryOfCall, liveSeeds, mapLimit, readDirectoryKeys, READ_CONCURRENCY } from './mesh/protocol/directory.js';
import { hasWebCrypto } from './mesh/protocol/keys.js';
import { chainHead, ledgerBody, signLedger } from './mesh/protocol/log.js';
import { roomCodeFor } from './mesh/protocol/pairing.js';
import { decodeStanding, standingCall } from './mesh/protocol/staking.js';
import { CHESS_RULESET_ID } from '../web3/wager';

export interface PlayerKey { publicKey: string; privateKey: string }
export interface RankedPlacement {
  launch: LaunchParams;
  shell: CabinetShell;
  matchId: string;
  host: string;
  opponent: string;
}
interface Peer { nodeId: string; addr?: string; wsAddr?: string | null; buildHashes?: Record<string, string>; standing?: number }
interface QueueEntry { rulesetId: string; mode: string; region: string | null }
interface Placed { matchId: string; host: string; participants: string[]; buildHash?: string | null; rulesetId: string }
/** The slice of LitNode's cabinet client (mesh/client.js) this page uses, typed. */
interface MeshClient {
  health(): Promise<{ region?: string | null }>;
  queue(entry: QueueEntry): Promise<{ bucket: number }>;
  waitForMatch(o: { timeoutMs: number; sinceBucket: number; requeue: QueueEntry; signal: AbortSignal; onTick(m: unknown): void; onPaired(m: unknown): void }):
    Promise<null | { match: Placed; check: { ok: boolean; reason?: string }; snapshot: { peers: Peer[] } }>;
}
const meshClient = createClient as unknown as (o: { nodeUrl: string; player: PlayerKey; rpc: (method: string, params: unknown[]) => Promise<unknown> }) => MeshClient;

const NODE_KEY = 'rapture-chess.mesh.node';
/** The LitNode contract set the arcade publishes (CORS open); the generation-3 addresses stand in when it is down. */
const CONTRACTS_URL = 'https://arcade.litvm.games/contracts.json';
const FALLBACK = { NodeDirectory: '0xac0C73008028E3eAA05Bc5C72f0C233F94b4E3df', NodeStake: '0x3CFe2D006d946A1E0E5Cf6B3E0958aFc3fF73717' };
const QUEUE_MS = 5 * 60_000;

const load = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string | null): void => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } };

/** Ed25519 in WebCrypto: every current browser on https; absent on plain http from a network address. */
export const canHoldKey = (): boolean => hasWebCrypto() && window.isSecureContext;

let key: Promise<PlayerKey> | null = null;
/** This browser's LitNode player key: made once, then kept. */
export function playerKey(): Promise<PlayerKey> {
  key ??= (loadPlayer(globalThis.localStorage) as Promise<PlayerKey>).catch((e: unknown) => { key = null; throw e; });
  return key;
}
let keyId: string | null = null;
void (canHoldKey() ? playerKey().then((k) => { keyId = k.publicKey; }, () => {}) : null);
/** The key's public half once loaded (sync, for the stakes panel), else null. */
export const playerKeyId = (): string | null => keyId;

let nodeUrl: string | null = load(NODE_KEY);
/** The node this page last queued through (the mesh entry point), if any. */
export const meshNode = (): string | null => nodeUrl;

async function contracts(): Promise<typeof FALLBACK> {
  try {
    const j = await (await fetch(CONTRACTS_URL, { signal: AbortSignal.timeout(5000) })).json() as { contracts?: Record<string, { address?: string }> };
    const dir = j.contracts?.NodeDirectory?.address, stake = j.contracts?.NodeStake?.address;
    if (dir && stake) return { NodeDirectory: dir, NodeStake: stake };
  } catch { /* the fallback */ }
  return FALLBACK;
}

const answers = async (url: string): Promise<boolean> => {
  try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; }
};

/**
 * A node to queue through: the last one that worked, else the freshest bonded node announced in NodeDirectory that
 * proves it holds the key its entry names (it signs our nonce: anyone can answer /health). Https only.
 */
export async function findNode(chain: ChainClient, say: (text: string) => void): Promise<string> {
  if (nodeUrl && await answers(nodeUrl)) return nodeUrl;
  say('Finding the LitNode mesh on chain…');
  const c = await contracts();
  const call = (payload: unknown): Promise<string> => chain.request('eth_call', [payload, 'latest']) as Promise<string>;
  const keys = await readDirectoryKeys(call, c.NodeDirectory) as string[];
  const entries: Record<string, unknown> = {}, stakes: Record<string, unknown> = {};
  await mapLimit(keys, Math.max(1, READ_CONCURRENCY / 2), async (k: string) => {
    try {
      const [e, s] = await Promise.all([call(entryOfCall(c.NodeDirectory, k)), call(standingCall(c.NodeStake, k))]);
      entries[k] = decodeEntry(e); stakes[k] = decodeStanding(s);
    } catch { /* this node is skipped */ }
  });
  const seeds = liveSeeds(entries, stakes) as Array<{ nodeId: string; url: string }>;
  say(`Reaching a node (${seeds.length} announced)…`);
  for (const s of seeds) {
    if (!/^https:/.test(s.url)) continue;
    try {
      const nonce = newNonce();
      const r = await fetch(`${s.url}/whoami?nonce=${nonce}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const proof = await checkChallenge(await r.json(), { expectNodeId: s.nodeId, nonce }) as { ok: boolean };
      if (!proof.ok) continue;
      nodeUrl = s.url.replace(/\/+$/, '');
      store(NODE_KEY, nodeUrl);
      return nodeUrl;
    } catch { /* the next one */ }
  }
  throw new Error('No LitNode node answers right now. Try again in a minute.');
}

/** A CabinetShell of our own: signs only the seat and the ledger of the match this page queued for, as the arcade. */
export function localShell(kp: PlayerKey, node: string, m: { matchId: string; buildHash: string | null; wsAddr: string; participants: string[]; rulesetId: string }): CabinetShell {
  return {
    init: { player: { id: kp.publicKey, guest: true }, node: { url: node, online: true }, match: { matchId: m.matchId, wsAddr: m.wsAddr, participants: m.participants, mode: 'ranked', buildHash: m.buildHash ?? undefined, rulesetId: m.rulesetId } },
    async signSeat(c: SeatChallenge): Promise<string> {
      const ok = c.matchId === m.matchId && c.room === roomCodeFor(m.matchId) && c.player === kp.publicKey && typeof c.nonce === 'string' && NONCE_RE.test(c.nonce);
      if (!ok) throw new Error('not a seat in the match this game queued for');
      return signSeat(c, kp.privateKey) as Promise<string>;
    },
    async signLedger(matchId, buildHash, entries): Promise<string> {
      if (matchId !== m.matchId) throw new Error('not the match this game queued for');
      if (m.buildHash && buildHash && buildHash !== m.buildHash) throw new Error('the relay names another build');
      let head: string | null = null;
      try { head = chainHead(entries) as string; } catch { /* a gap or a reorder */ }
      if (!head || !entries.length) throw new Error('the log has a gap or a reorder');
      return signLedger(ledgerBody({ matchId, ticks: entries.length, head, buildHash: m.buildHash ?? buildHash ?? null }), kp) as Promise<string>;
    },
    exit: () => {},
    close: () => {},
  };
}

/**
 * Queue for a ranked match and wait (re-entering every 2 s bucket, up to five minutes) until the mesh pairs this key.
 * Resolves with what RelayMatch.placed needs, or null when stopped or nobody came.
 */
export async function findRanked(o: { chain: ChainClient; signal: AbortSignal; say(text: string): void }): Promise<RankedPlacement | null> {
  const kp = await playerKey();
  const node = await findNode(o.chain, o.say);
  if (o.signal.aborted) return null;
  const rpc = (method: string, params: unknown[]): Promise<unknown> => o.chain.request(method, params);
  const client = meshClient({ nodeUrl: node, player: kp, rpc });
  const region = await client.health().then((h) => h.region ?? null, () => null);
  const entry: QueueEntry = { rulesetId: CHESS_RULESET_ID, mode: 'ranked', region };
  o.say('Signing your queue entry…');
  let bucket: number;
  try { ({ bucket } = await client.queue(entry)); } catch (e) {
    // a node that went away since the last visit: forget it, so the next try reads the directory again
    if (/fetch|network|failed/i.test((e as Error).message)) { nodeUrl = null; store(NODE_KEY, null); }
    throw e;
  }
  const t0 = Date.now();
  const r = await client.waitForMatch({
    timeoutMs: QUEUE_MS, sinceBucket: bucket, requeue: entry, signal: o.signal,
    onTick: (m) => { if (!m) o.say(`Searching for an opponent… ${Math.round((Date.now() - t0) / 1000)} s`); },
    onPaired: () => o.say('Opponent found. Checking the placement and the host…'),
  });
  if (!r) return null;
  if (!r.check.ok) throw new Error(`The placement did not check out (${r.check.reason ?? 'unknown'}): not joining.`);
  const m = r.match;
  // the relay both players join: the host's, else the arcade's fallback (the lowest-keyed bonded peer serving this build)
  const host = r.snapshot.peers.find((p) => p.nodeId === m.host) ?? null;
  const relay = host?.wsAddr || r.snapshot.peers.filter((p) => p.wsAddr && p.buildHashes?.[m.rulesetId] && p.standing !== 0).sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))[0]?.wsAddr || null;
  if (!relay) throw new Error('The host runs no match server for Rapture Chess.');
  const buildHash = m.buildHash ?? null;
  // claims read the delta from the host, where the relay settles it
  const shell = localShell(kp, host?.addr?.replace(/\/+$/, '') ?? node, { matchId: m.matchId, buildHash, wsAddr: relay, participants: m.participants, rulesetId: m.rulesetId });
  const launch: LaunchParams = { ws: relay, room: roomCodeFor(m.matchId) as string, player: kp.publicKey, matchId: m.matchId, buildHash, placed: true };
  return { launch, shell, matchId: m.matchId, host: m.host, opponent: m.participants.find((p) => p !== kp.publicKey) ?? '' };
}
