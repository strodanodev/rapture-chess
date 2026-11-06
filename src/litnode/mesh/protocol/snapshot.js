/** Registry snapshot from signed heartbeats. BUILD-SPEC §3, pure given `now`.
 *
 *  A heartbeat body: { nodeId, operator, roles, region, addr, wsAddr, standing,
 *  buildHashes: {rulesetId: buildHash}, manifests: {rulesetId: manifest}, epoch }.
 *  Signed by nodeId under HEARTBEAT_TAG; a heartbeat whose signer ≠ nodeId is
 *  discarded, so a node cannot advertise on another's behalf.
 *
 *  Manifest resolution: where operators advertise different builds of the
 *  same ruleset, the build held by the most nodes wins, ties lexicographic —
 *  one operator cannot fork a title by advertising alone. */
import { canonical, h } from './canonical.js';
import { opened } from './keys.js';

export const HEARTBEAT_TAG = 'heartbeat';
export const EPOCH_MS = 2000;
export const epochOf = (ms) => Math.floor(ms / EPOCH_MS);
export const isFresh = (hb, nowMs) => hb.epoch >= epochOf(nowMs) - 2;

/** Verify a batch of heartbeat envelopes; returns the valid bodies. */
export async function verifyHeartbeats(envelopes) {
  const out = [];
  for (const env of envelopes)
    if (env?.body?.nodeId === env?.signer && await opened(HEARTBEAT_TAG, env)) out.push(env.body);
  return out;
}

/** Latest heartbeat per node, fresh only. */
export function freshPeers(bodies, nowMs) {
  const latest = new Map();
  for (const b of bodies) {
    if (!isFresh(b, nowMs)) continue;
    const cur = latest.get(b.nodeId);
    if (!cur || b.epoch > cur.epoch) latest.set(b.nodeId, b);
  }
  return [...latest.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
}

/** One manifest per rulesetId by majority buildHash, lexicographic tiebreak. */
export function resolveManifests(peers) {
  const votes = new Map(); // rulesetId → Map(buildHash → {count, manifest})
  for (const p of peers)
    for (const [rid, bh] of Object.entries(p.buildHashes ?? {})) {
      const m = p.manifests?.[rid];
      if (!m || m.buildHash !== bh) continue;
      const per = votes.get(rid) ?? votes.set(rid, new Map()).get(rid);
      const v = per.get(bh) ?? per.set(bh, { count: 0, manifest: m }).get(bh);
      v.count++;
    }
  const out = {};
  for (const [rid, per] of votes) {
    const best = [...per.entries()].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))[0];
    out[rid] = best[1].manifest;
  }
  return out;
}

/** The root commits to what placement reads — membership, roles, region,
 *  standing, builds, manifests, and whether a node fronts a relay and which
 *  titles it runs as gauntlets (placement orders hosts by both) — and NOT to
 *  heartbeat epochs or addresses, so two snapshots taken seconds apart with
 *  the same eligible set hash the same. That is what lets a client tell "the
 *  node lied" from "the set moved". The relay is committed as a yes/no, not
 *  its URL: a quick tunnel's hostname changes on every restart. */
const registryView = (peers, manifests) => ({
  peers: peers.map((p) => ({
    nodeId: p.nodeId, operator: p.operator, roles: p.roles, region: p.region, standing: p.standing, buildHashes: p.buildHashes,
    ...(p.wsAddr ? { relay: true } : {}),
    ...(Array.isArray(p.gauntlets) && p.gauntlets.length ? { gauntlets: [...p.gauntlets].sort() } : {}),
  })),
  manifests,
});
export const snapshotRoot = (s) => h('snapshot', registryView(s.peers, s.manifests));

export function snapshot(bodies, nowMs) {
  const peers = freshPeers(bodies, nowMs);
  const manifests = resolveManifests(peers);
  const epoch = epochOf(nowMs);
  return { epoch, peers, manifests, root: snapshotRoot({ peers, manifests }) };
}
