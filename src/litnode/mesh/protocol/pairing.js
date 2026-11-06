/** Pairing: deterministic over the gossiped queue. BUILD-SPEC §5.1 with the
 *  review fixes:
 *
 *   - only CLOSED buckets pair (bucket < now - 1), so partial gossip cannot
 *     make two nodes pair the same closed bucket differently once both hold
 *     its union;
 *   - one entry per player per bucket — duplicates cannot pair with
 *     themselves (the Agent Fighter self-match bug class);
 *   - the beacon for a bucket is chosen AFTER the bucket closes, so neither
 *     player nor host can grind it. On litVM that is the first block whose
 *     timestamp is ≥ the bucket end (see beacon.js); blockhash is not secure
 *     against the sequencer, and the spec says so rather than pretending. */
import { h } from './canonical.js';

export const BUCKET_MS = 2000;
export const bucketOf = (ms) => Math.floor(ms / BUCKET_MS);
export const bucketEnd = (bucket) => (bucket + 1) * BUCKET_MS;
export const isClosed = (bucket, nowMs) => bucket < bucketOf(nowMs) - 1;
/** A queue entry outlives its bucket by this much and no more. A player who
 *  is still looking re-queues every bucket; an entry older than this is a
 *  browser that left, and pairing it would place a match nobody plays. Every
 *  node prunes on the same rule, so the gossiped queue converges to empty. */
export const QUEUE_TTL_MS = 60_000;
export const isStale = (bucket, nowMs) => bucketEnd(bucket) < nowMs - QUEUE_TTL_MS;

export const QUEUE_TAG = 'queue';

export const matchIdFor = (rulesetId, p1, p2, beacon) => h('match', rulesetId, p1, p2, beacon);

/** A rendezvous code a title's own relay can key on (Agent Fighter's
 *  friendly rooms take [A-Z0-9-]{3,40}): the mesh match, shortened. Both
 *  placed players derive it from the same matchId and land in the same
 *  room; the relay's ledger carries it back so the mesh settles the result
 *  under the match it placed. */
export const roomCodeFor = (matchId) => `LIT-${String(matchId).slice(0, 32).toUpperCase()}`;

/** @param {Array} entries  verified queue bodies {playerId, rulesetId, tokenId, mode, bucket, region?}
 *  @param {number} nowMs
 *  @param {(bucket:number)=>string|null} beaconFor  null = beacon not yet known → bucket skipped
 *  @returns {Array<{matchId, rulesetId, mode, bucket, beacon, participants, regions}>} */
export function pair(entries, nowMs, beaconFor) {
  const seen = new Set();
  const closed = entries
    .filter((e) => isClosed(e.bucket, nowMs) && !isStale(e.bucket, nowMs))
    .filter((e) => { const k = `${e.bucket}|${e.playerId}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.bucket - b.bucket || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));

  const out = [];
  let i = 0;
  while (i < closed.length) {
    const a = closed[i];
    const beacon = beaconFor(a.bucket);
    const b = closed[i + 1];
    if (beacon && b && b.bucket === a.bucket && b.rulesetId === a.rulesetId && b.mode === a.mode && b.playerId !== a.playerId) {
      out.push({
        matchId: matchIdFor(a.rulesetId, a.playerId, b.playerId, beacon),
        rulesetId: a.rulesetId, mode: a.mode, bucket: a.bucket, beacon,
        participants: [a.playerId, b.playerId],
        tokens: [a.tokenId ?? null, b.tokenId ?? null],
        regions: [a.region ?? null, b.region ?? null],
      });
      i += 2;
    } else {
      i += 1;
    }
  }
  return out;
}
