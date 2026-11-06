/** The hash-chained input log and the once-per-player ledger signature.
 *
 *  BUILD-SPEC §6 (revised): per-tick signatures are withdrawn — verifying one
 *  per tick costs ~300× the replay. Instead every tick is chained, and each
 *  player signs the chain head once at match end. What that buys:
 *
 *   - the tick number is inside the chained entry, so a host cannot reorder,
 *     delay or drop an input without changing the head both players sign;
 *   - a player who disagrees with the host's log simply does not sign it —
 *     the delta then carries one signature and settles as disputed;
 *   - a witness verifies two signatures and one chain walk, then replays.
 *
 *  Entry shape: { k: tick, inputs: [frameSide0, frameSide1] }. Frames are
 *  whatever the title's step() consumes (Agent Fighter: bitfield ints). */
import { canonical, h } from './canonical.js';
import { sign, verify } from './keys.js';

export const GENESIS = 'genesis';
export const LEDGER_TAG = 'ledger';

export const chainStep = (prev, entry) => h('tick', prev, entry);

/** Walk a log. Throws on a gap or reorder — a log that is not exactly
 *  0..n-1 is not a log. Returns the chain head. */
export function chainHead(entries) {
  let head = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.k !== i) throw new Error(`log: tick ${e.k} at index ${i}`);
    head = chainStep(head, { k: e.k, inputs: e.inputs });
  }
  return head;
}

/** Incremental writer for the host: append(inputs) → { k, head }. */
export function createLog() {
  const entries = [];
  let head = GENESIS;
  return {
    append(inputs) {
      const e = { k: entries.length, inputs };
      entries.push(e);
      head = chainStep(head, e);
      return { k: e.k, head };
    },
    get head() { return head; },
    get length() { return entries.length; },
    entries: () => entries.slice(),
  };
}

/** What a player signs: the match, the tick count, the chain head and the
 *  ruleset build. Protocol 3 dropped the hydration hash from this body: a
 *  player can neither verify nor influence hydration (the node and the
 *  witness compute it themselves, bound to the placement's registry block),
 *  and for relay matches it depends on the relay's own pin, which no client
 *  can know at match end — so requiring it made player signatures
 *  impossible in practice. `hydrationHash` is accepted and ignored. */
export const ledgerBody = ({ matchId, ticks, head, buildHash }) =>
  ({ matchId, ticks, head, buildHash });

export const signLedger = (body, kp) => sign(LEDGER_TAG, body, kp.privateKey);

/** Verify a delta's log against its signatures. Returns
 *  { ok, head, signed: [playerId...], reason } — never throws. */
export async function verifyLedger({ entries, matchId, participants, buildHash, hydrationHash, signatures }) {
  let head;
  try { head = chainHead(entries); } catch (e) { return { ok: false, head: null, signed: [], reason: e.message }; }
  const body = ledgerBody({ matchId, ticks: entries.length, head, buildHash, hydrationHash });
  const signed = [];
  for (const p of participants)
    if (signatures?.[p] && await verify(LEDGER_TAG, body, signatures[p], p)) signed.push(p);
  const ok = signed.length === participants.length;
  return { ok, head, signed, reason: ok ? null : `signed by ${signed.length}/${participants.length}` };
}

export const logHash = (entries) => h('log', canonical(entries));
