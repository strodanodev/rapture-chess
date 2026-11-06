/** The arcade client, isomorphic: the same file drives the lobby page in a
 *  browser and the client test in Node. It owns the player identity, signs
 *  queue entries, polls for a pair, and — the point of the design — recomputes
 *  placement from a snapshot it can hash and refuses a host the rule did not
 *  produce. A node is a directory, never an authority. */
import { generateKeypair, seal } from './protocol/keys.js';
import { placement } from './protocol/placement.js';
import { QUEUE_TAG, bucketOf, bucketEnd } from './protocol/pairing.js';
import { snapshotRoot, snapshot as buildSnapshot, verifyHeartbeats } from './protocol/snapshot.js';
import { applyStakes } from './protocol/staking.js';
import { h } from './protocol/canonical.js';

export const IDENTITY_KEY = 'litnode.player';

/** Load or create the player keypair. `storage` is localStorage-shaped. */
export async function loadPlayer(storage) {
  try {
    const raw = storage?.getItem(IDENTITY_KEY);
    if (raw) { const kp = JSON.parse(raw); if (kp.publicKey && kp.privateKey) return kp; }
  } catch {}
  const kp = await generateKeypair();
  try { storage?.setItem(IDENTITY_KEY, JSON.stringify(kp)); } catch {}
  return kp;
}

/** @param rpc  optional async (method, params) → result, for checking a chain beacon
 *              against the block it names (cabinet/seeds.js exports one). */
export function createClient({ nodeUrl, player, fetchImpl = globalThis.fetch, rpc = null }) {
  const base = nodeUrl.replace(/\/+$/, '');
  const get = async (p) => { const r = await fetchImpl(`${base}${p}`); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); };

  const snapshot = () => get('/snapshot');
  /** The snapshot REBUILT here from the node's signed heartbeat envelopes:
   *  every signature re-verified, the root recomputed. What the node said
   *  about membership is then a claim we checked, not one we took. `stakes`
   *  (the bonded set) is still the node's read of the chain in this build —
   *  reported as `stakesFrom: 'node'`; a browser with an rpc could read
   *  standings itself. */
  const verifiedSnapshot = async () => {
    const s = await get('/snapshot?envelopes=1');
    const bodies = await verifyHeartbeats(s.envelopes ?? []);
    const mine = buildSnapshot(bodies.filter((b) => (b.protocol ?? 1) === (s.protocol ?? 1)), Date.now());
    if (s.stakes) mine.peers = applyStakes(mine.peers, s.stakes);
    return { ...mine, staking: s.staking, stakesFrom: s.stakes ? 'node' : 'none', verified: true, nodeRoot: s.root, envelopes: s.envelopes.length, signed: bodies.length };
  };
  /** A chain beacon is H('beacon', hash of the first block at/after the bucket end). With an rpc, check the block the descriptor names. */
  const verifyBeacon = async (m) => {
    if (m.beaconSource !== 'chain') return { ok: m.beaconSource === 'local', source: m.beaconSource ?? null, reason: m.beaconSource === 'local' ? 'offline mesh (local beacon, labelled)' : 'beacon source unknown' };
    if (!rpc) return { ok: null, source: 'chain', reason: 'no rpc to check the block' };
    if (m.beaconBlock == null) return { ok: false, source: 'chain', reason: 'descriptor names no block' };
    try {
      const b = await rpc('eth_getBlockByNumber', ['0x' + Number(m.beaconBlock).toString(16), false]);
      if (!b) return { ok: false, source: 'chain', reason: 'block not found' };
      if (h('beacon', b.hash) !== m.beacon) return { ok: false, source: 'chain', reason: 'beacon is not that block\'s hash' };
      if (parseInt(b.timestamp, 16) < bucketEnd(m.bucket) / 1000) return { ok: false, source: 'chain', reason: 'block precedes the bucket end (grindable)' };
      return { ok: true, source: 'chain', block: m.beaconBlock };
    } catch (e) { return { ok: null, source: 'chain', reason: e.message }; }
  };
  const health = () => get('/health');
  const leaderboard = (rulesetId) => get(`/leaderboard?ruleset=${encodeURIComponent(rulesetId)}`);
  const stats = (rulesetId) => get(`/stats?ruleset=${encodeURIComponent(rulesetId)}&player=${player.publicKey}`);
  const deltas = (rulesetId) => get(`/deltas${rulesetId ? `?ruleset=${encodeURIComponent(rulesetId)}` : ''}`);
  const epoch = () => get('/epoch');

  /** Sign and submit a queue entry. The node cannot enqueue anyone else. */
  const queue = async ({ rulesetId, mode = 'ranked', tokenId = '1', region = null }) => {
    const body = { playerId: player.publicKey, rulesetId, tokenId, mode, bucket: bucketOf(Date.now()), region };
    const env = await seal(QUEUE_TAG, body, player);
    const r = await fetchImpl(`${base}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `queue: ${r.status}`);
    return { bucket: body.bucket };
  };

  /** The node's descriptor for my LATEST match, if any. Frozen descriptors
   *  live for a while, so an older pairing must not shadow a new queue. */
  const match = async ({ sinceBucket = 0 } = {}) => {
    const ms = (await get(`/match?playerId=${player.publicKey}`)).matches.filter((m) => m.bucket >= sinceBucket);
    return ms.sort((a, b) => b.bucket - a.bucket)[0] ?? null;
  };

  /** Recompute placement from a snapshot and compare with what the node
   *  says. Returns { ok, host, witness, nodeHost, reason }. */
  const verifyPlacement = (m, s) => {
    const manifest = s.manifests[m.rulesetId];
    if (!manifest) return { ok: false, reason: 'ruleset not in snapshot' };
    const mine = placement({ nodes: s.peers, manifest, rulesetId: m.rulesetId, matchId: m.matchId, beacon: m.beacon, regions: m.regions ?? [] });
    const host = mine.host?.nodeId ?? null;
    const sameSnapshot = snapshotRoot(s) === m.snapshotRoot;
    if (host === m.host) return { ok: true, host, witness: mine.witness?.nodeId ?? null, nodeHost: m.host, sameSnapshot };
    return { ok: false, host, witness: mine.witness?.nodeId ?? null, nodeHost: m.host, sameSnapshot,
      reason: sameSnapshot ? 'node named a host the rule did not produce' : 'computed against a different snapshot (eligible set moved)' };
  };

  /** A ranked placement is the HOST's to commit on chain, and the host commits the earliest placement it knows
   *  for these players — which may not be the one the node we poll showed first (two nodes can pair the same
   *  players a bucket apart while gossip catches up). So before launching, ask the host itself: the entry it
   *  lists for us WITH a commit transaction is the match. Unreachable host (a LAN address from a browser
   *  elsewhere) → the placement we have, unconfirmed. A host that says it will not commit (`commitSkipped`: the draw
   *  seated fewer than three witnesses, so the match stands casual-only) ends the wait at once: waiting out the
   *  deadline for a transaction nobody sends froze the Find match panel for 15 s (23 Sep 2026). */
  const confirmWithHost = async (m, s, { deadlineMs = 15_000, signal } = {}) => {
    if ((m.mode ?? 'casual') !== 'ranked') return null;
    const host = s.peers?.find((p) => p.nodeId === m.host);
    if (!host?.addr) return null;
    const end = Date.now() + deadlineMs;
    while (Date.now() < end && !signal?.aborted) {
      try {
        const r = await fetchImpl(`${host.addr}/match?playerId=${player.publicKey}`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return null;
        const ours = (await r.json()).matches.filter((x) => x.rulesetId === m.rulesetId && x.mode === 'ranked' && m.participants.every((p) => x.participants.includes(p)));
        const committed = ours.find((x) => x.commitTx);
        if (committed) return { ...committed, confirmedByHost: true };
        const skipped = ours.find((x) => x.matchId === m.matchId && x.commitSkipped);
        if (skipped) return { ...skipped, confirmedByHost: true, casualOnly: skipped.commitSkipped };
      } catch { return null; }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  };

  /** Poll until paired (or timeout), then verify. With `requeue`, a fresh
   *  entry is signed for every bucket while waiting: an entry lives in ONE
   *  2 s bucket (protocol/pairing.js), so two players who click ten seconds
   *  apart never meet unless the earlier one keeps re-entering. */
  const waitForMatch = async ({ timeoutMs = 30_000, intervalMs = 500, sinceBucket = 0, requeue = null, onTick, onPaired, signal } = {}) => {
    const t0 = Date.now();
    let lastBucket = bucketOf(Date.now());
    let failures = 0;
    while (Date.now() - t0 < timeoutMs && !signal?.aborted) {
      // One dropped poll (a tunnel blip, a node restart) must not end a five-minute queue; four in a row is an outage.
      let m;
      try { m = await match({ sinceBucket }); failures = 0; }
      catch (e) { if (++failures > 3) throw e; await new Promise((r) => setTimeout(r, intervalMs)); continue; }
      onTick?.(m);
      if (m) {
        onPaired?.(m); // paired: what follows (snapshot, the host's commit, the beacon) takes seconds, and the page should say so
        const s = (await verifiedSnapshot().catch(() => null)) ?? await snapshot();
        const confirmed = await confirmWithHost(m, s, { deadlineMs: Math.max(0, Math.min(15_000, t0 + timeoutMs - Date.now())), signal });
        if (confirmed) Object.assign(m, confirmed);
        const check = verifyPlacement(m, s);
        const beacon = await verifyBeacon(m);
        if (beacon.ok === false) { check.ok = false; check.reason = `beacon: ${beacon.reason}`; }
        return { match: m, check: { ...check, beacon, snapshotVerified: !!s.verified }, snapshot: s, waitedMs: Date.now() - t0 };
      }
      const b = bucketOf(Date.now());
      if (requeue && b !== lastBucket) { lastBucket = b; await queue(requeue).catch(() => {}); }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  };

  return { base, player, snapshot, verifiedSnapshot, verifyBeacon, health, leaderboard, stats, deltas, epoch, queue, match, verifyPlacement, confirmWithHost, waitForMatch };
}
