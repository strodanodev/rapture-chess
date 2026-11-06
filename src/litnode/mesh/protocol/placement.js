/** Placement: a pure function of state everybody already has. Runs unchanged
 *  in the node and the browser. BUILD-SPEC §5, with the review fixes:
 *
 *   - publisher affinity keys on publisher NODE KEYS in the manifest, not on a
 *     self-asserted operator string;
 *   - region-aware: nodes in a participant's region come first (stable), so a
 *     reproducible draw is also a playable one;
 *   - witness must be under a different operator AND a different node key;
 *   - hosts that advertise a relay (wsAddr) come first (stable), because a
 *     match on a relay-less host cannot be played until P2P lands.
 *
 *  Standing and operator are still self-asserted in this build (§16) — that
 *  is what "known operators only" means until the registry is on chain. */
import { h } from './canonical.js';

export const seedFor = (beacon, matchId) => h('seed', beacon, matchId);

const eligible = (nodes, rulesetId, manifest) =>
  nodes.filter((n) =>
    n.roles?.includes('host')
    && n.buildHashes?.[rulesetId] === manifest.buildHash
    && (n.standing ?? 0) >= (manifest.standingFloor ?? 0));

/** @param {object} args
 *  @param {Array} args.nodes      fresh registry entries {nodeId, operator, roles, region, buildHashes, standing}
 *  @param {object} args.manifest  ruleset manifest {buildHash, standingFloor, hostPolicy}
 *  @param {string} args.rulesetId
 *  @param {string} args.matchId
 *  @param {string} args.beacon
 *  @param {string[]} [args.regions]  participants' regions, for affinity
 *  @returns {{seed, host, witness, order}} host/witness are nodes or null */
export function placement({ nodes, manifest, rulesetId, matchId, beacon, regions = [] }) {
  const seed = seedFor(beacon, matchId);
  const ranked = eligible(nodes, rulesetId, manifest)
    .map((n) => ({ n, r: h('order', seed, n.nodeId) }))
    .sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0))
    .map((x) => x.n);

  // Stable partitions, applied innermost first so the outer one wins.
  let order = ranked;
  const wanted = new Set(regions.filter(Boolean));
  if (wanted.size) order = [...order.filter((n) => wanted.has(n.region)), ...order.filter((n) => !wanted.has(n.region))];
  const pub = new Set(manifest.hostPolicy?.affinity === 'operator' ? manifest.hostPolicy.publisherNodes ?? [] : []);
  if (pub.size) order = [...order.filter((n) => pub.has(n.nodeId)), ...order.filter((n) => !pub.has(n.nodeId))];
  // Outermost: a host that fronts a relay (wsAddr) before one that does not.
  // Until play is peer-to-peer, a match on a relay-less host is placed but
  // not playable (seen live: the draw picked a laptop with no relay while
  // the desktop had one). Stable, so the seeded order still decides among
  // relay hosts, and the open fallback remains when nobody has one.
  if (order.some((n) => n.wsAddr)) order = [...order.filter((n) => n.wsAddr), ...order.filter((n) => !n.wsAddr)];
  // Outermost of all: for a title whose match server runs ON the node (a gauntlet, node/gauntlet.js),
  // the nodes that advertise running it come first. Only those can seat the players; a match drawn
  // onto any other host has no court. Stable, and a no-op for titles nobody runs as a gauntlet.
  const runs = (n) => Array.isArray(n.gauntlets) && n.gauntlets.includes(rulesetId);
  if (order.some(runs)) order = [...order.filter(runs), ...order.filter((n) => !runs(n))];

  const host = order[0] ?? null;
  // The witness PANEL (BUILD-SPEC v0.3 §5): k = 3, drawn from the same seed,
  // stake-weighted — the draw key is H(seed ‖ nodeId) divided by the bonded
  // amount, smallest first, so twice the bond is drawn about twice as often
  // (integer arithmetic, so node and browser agree bit for bit). A seat needs
  // the witness role, the same build, witness eligibility on chain (a bond
  // older than the eligibility age; `eligible === false` excludes, unset
  // is the dev mesh), a different node key than the host and a staking
  // address different from the host's AND from every other seat's.
  // A seat needs the build and the title's standing floor, not the host role.
  const holders = nodes.filter((n) => n.buildHashes?.[rulesetId] === manifest.buildHash && (n.standing ?? 0) >= (manifest.standingFloor ?? 0));
  const panel = host ? drawPanel(holders, seed, host, PANEL) : [];
  // `witness` stays the first seat for readers that predate the panel.
  const witness = panel[0] ?? null;

  return { seed, host, witness, panel, order };
}

export const PANEL = 3;
const weightKey = (seed, n) => BigInt('0x' + h('panel', seed, n.nodeId)) / BigInt(Math.max(1, Math.floor(n.standing ?? 0)));
export function drawPanel(candidates, seed, host, k = PANEL) {
  const pool = candidates
    .filter((n) => n.nodeId !== host.nodeId && n.operator !== host.operator && n.roles?.includes('witness') && n.eligible !== false)
    .map((n) => ({ n, key: weightKey(seed, n) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.n.nodeId < b.n.nodeId ? -1 : 1))
    .map((x) => x.n);
  const out = [];
  for (const n of pool) { if (out.length === k) break; if (!out.some((s) => s.operator === n.operator)) out.push(n); }
  return out;
}

/** A client that was told "connect to X" checks X against the rule. */
export const acceptsHost = (args, nodeId) => placement(args).host?.nodeId === nodeId;
