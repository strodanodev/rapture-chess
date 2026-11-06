/** ed25519 identity. The public key IS the identifier: nodeId, playerId.
 *
 *  WebCrypto only, so the same file runs in a browser and in Node (≥ 20).
 *  Keys are handled as raw hex: 32-byte public key, 32-byte private seed.
 *  Signatures are over canonical bytes of a tagged body, so a signature made
 *  for one purpose can never be replayed as another. */
import { canonical } from './canonical.js';

const subtle = globalThis.crypto?.subtle;
const enc = new TextEncoder();

/** Browsers expose WebCrypto only in a SECURE CONTEXT: https, or localhost.
 *  A lobby opened as http://<lan-ip>/ has no `crypto.subtle` and cannot hold a
 *  key. That is a property of the platform, not a bug here — in production a
 *  node is reached over https (tunnel or reverse proxy); on a LAN, open the
 *  node on the machine itself as http://localhost:<port>/. */
export const hasWebCrypto = () => !!subtle;
const needSubtle = () => {
  if (!subtle) throw new Error('WebCrypto unavailable: open this page over https or localhost (insecure context has no crypto.subtle)');
  return subtle;
};

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (hex) => {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

// PKCS#8 wrapper for a raw 32-byte ed25519 seed (RFC 8410).
const PKCS8_PREFIX = fromHex('302e020100300506032b657004220420');
const seedToPkcs8 = (seed) => { const b = new Uint8Array(48); b.set(PKCS8_PREFIX); b.set(seed, 16); return b; };

/** Generate an identity: { publicKey, privateKey } as hex. */
export async function generateKeypair() {
  const kp = await needSubtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await needSubtle().exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await needSubtle().exportKey('pkcs8', kp.privateKey));
  return { publicKey: toHex(pub), privateKey: toHex(pkcs8.slice(16)) };
}

const importPrivate = (seedHex) =>
  needSubtle().importKey('pkcs8', seedToPkcs8(fromHex(seedHex)), { name: 'Ed25519' }, false, ['sign']);
const importPublic = (pubHex) =>
  needSubtle().importKey('raw', fromHex(pubHex), { name: 'Ed25519' }, false, ['verify']);

/** Bytes that get signed: tag NUL canonical(body). Tag binds purpose. */
export const signingBytes = (tag, body) => enc.encode(`${tag}\0${canonical(body)}`);

/** Sign a body under a purpose tag. Returns hex signature (64 bytes). */
export async function sign(tag, body, privateKeyHex) {
  const key = await importPrivate(privateKeyHex);
  return toHex(new Uint8Array(await needSubtle().sign({ name: 'Ed25519' }, key, signingBytes(tag, body))));
}

/** Verify; never throws — a malformed key or signature is simply false. */
export async function verify(tag, body, signatureHex, publicKeyHex) {
  try {
    const key = await importPublic(publicKeyHex);
    return await needSubtle().verify({ name: 'Ed25519' }, key, fromHex(signatureHex), signingBytes(tag, body));
  } catch { return false; }
}

/** Sign RAW BYTES — no tag, no canonical JSON. Only for messages that carry
 *  their own domain separation in the bytes themselves, such as the
 *  generation-4 NodeStake bond proof ("litnode-bond-v1" ‖ 0x00 ‖ chain,
 *  contract, operator; protocol/staking.js bondMessage), which a contract
 *  verifies byte for byte. Returns the 64-byte signature as hex. */
export async function signRaw(bytes, privateKeyHex) {
  const key = await importPrivate(privateKeyHex);
  return toHex(new Uint8Array(await needSubtle().sign({ name: 'Ed25519' }, key, bytes)));
}

/** Verify a raw-bytes signature; never throws. */
export async function verifyRaw(bytes, signatureHex, publicKeyHex) {
  try {
    const key = await importPublic(publicKeyHex);
    return await needSubtle().verify({ name: 'Ed25519' }, key, fromHex(signatureHex), bytes);
  } catch { return false; }
}

/** A signed envelope: { body, signer, sig }. `signer` is the public key and the
 *  identifier the body names must equal it wherever identity matters
 *  (queue entries, heartbeats) — callers check that; this checks the math. */
export const seal = async (tag, body, kp) => ({ body, signer: kp.publicKey, sig: await sign(tag, body, kp.privateKey) });
export const opened = (tag, env) => (env && env.body && env.signer && env.sig ? verify(tag, env.body, env.sig, env.signer) : Promise.resolve(false));
