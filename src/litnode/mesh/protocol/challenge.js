/** Proof of possession for a discovered endpoint. A directory entry says
 *  "node key K is at URL U"; a /health answer from U proves only that
 *  something answers there. The reader sends a nonce and the node signs it
 *  with K — a URL that cannot do that is not that node, whatever it says.
 *
 *  GET /whoami?nonce=<hex>  →  { nodeId, nonce, addr, at, sig }
 *  where sig = sign('whoami', { nodeId, nonce, addr, at }, nodeKey).
 *
 *  With `digest` (GET /fleet?nonce=): the same answer binds a document — the hash of the body it travels
 *  with — so a dashboard can tell "this node said this, now" from a replay or a proxy that edited it. */
import { sign, verify } from './keys.js';

export const WHOAMI_TAG = 'whoami';
export const NONCE_RE = /^[0-9a-f]{16,64}$/;

export async function answerChallenge({ nodeId, nonce, addr, at = Date.now(), digest = null }, privateKey) {
  const body = { nodeId, nonce, addr: addr ?? null, at, ...(digest ? { digest } : {}) };
  return { ...body, sig: await sign(WHOAMI_TAG, body, privateKey) };
}

/** Verify an answer against the identity the reader EXPECTED and the nonce it sent. */
export async function checkChallenge(answer, { expectNodeId, nonce, expectDigest = null, maxSkewMs = 120_000, now = Date.now() }) {
  if (!answer || answer.nodeId !== expectNodeId) return { ok: false, reason: 'identity' };
  if (answer.nonce !== nonce) return { ok: false, reason: 'nonce' };
  if (expectDigest && answer.digest !== expectDigest) return { ok: false, reason: 'digest' };
  if (typeof answer.at !== 'number' || Math.abs(now - answer.at) > maxSkewMs) return { ok: false, reason: 'stale' };
  const { sig, ...body } = answer;
  return (await verify(WHOAMI_TAG, body, sig, expectNodeId)) ? { ok: true } : { ok: false, reason: 'signature' };
}

/** A seat claim (node/gauntlet.js). A placed match's join ticket is a bearer
 *  credential for that player's seat, and match ids and participants are
 *  public, so naming a player is not enough: the host issues a one-time
 *  nonce and hands the ticket only against the player key's signature over
 *  { matchId, room, player, nonce }. The arcade shell signs it for a title it
 *  launched (cabinet:sign-seat); a title holding the player key signs itself.
 *
 *  GET <wsAddr>/<room>/ticket?player=<key>                   → 401 { challenge }
 *  GET <wsAddr>/<room>/ticket?player=<key>&nonce=<n>&sig=<s> → 200 { ticket, ws, … } */
export const SEAT_TAG = 'seat';
export const seatBody = ({ matchId, room, player, nonce }) => ({ matchId, room, player, nonce });
export const signSeat = (claim, privateKey) => sign(SEAT_TAG, seatBody(claim), privateKey);
export const verifySeat = (claim, sig) => verify(SEAT_TAG, seatBody(claim), sig, claim.player);

/** A random nonce as hex, from whatever crypto the runtime has (browser or Node). */
export const newNonce = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
