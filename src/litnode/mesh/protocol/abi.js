/** ABI encoding for the few shapes the protocol reads and writes. Pure and
 *  browser-safe (TextEncoder/TextDecoder only, no Buffer, no node:crypto):
 *  the cabinet decodes NodeDirectory entries with this; the node's signer
 *  (evm.js) re-exports it. */
const enc = new TextEncoder(), dec = new TextDecoder();
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const word = (h) => h.replace(/^0x/, '').padStart(64, '0');
const strWords = (s) => { const b = toHex(enc.encode(s)); return { len: word((b.length / 2).toString(16)), data: b.padEnd(Math.ceil(b.length / 64) * 64, '0') }; };

/** Encode (bytes32, string, string) — dynamic strings go tail-first with offsets. */
export function encodeBytes32StringString(b32hex, s1, s2) {
  const a = strWords(s1), b = strWords(s2);
  const head = 3 * 32;
  const off1 = head, off2 = head + 32 + a.data.length / 2;
  return word(b32hex) + word(off1.toString(16)) + word(off2.toString(16)) + a.len + a.data + b.len + b.data;
}
/** Decode a return of (string, string, uint64, address). */
export function decodeStringStringUintAddress(hexRet) {
  const d = hexRet.replace(/^0x/, '');
  const w = (i) => d.slice(i * 64, i * 64 + 64);
  const str = (off) => { const o = Number(BigInt('0x' + off)) * 2; const l = Number(BigInt('0x' + d.slice(o, o + 64))); return dec.decode(fromHex(d.slice(o + 64, o + 64 + l * 2))); };
  return { url: str(w(0)), wsAddr: str(w(1)), updatedAt: Number(BigInt('0x' + w(2))), announcer: '0x' + w(3).slice(24) };
}
/** Decode a bytes32[] return. */
export function decodeBytes32Array(hexRet) {
  const d = hexRet.replace(/^0x/, '');
  if (d.length < 128) return [];
  const off = Number(BigInt('0x' + d.slice(0, 64))) * 2;
  const n = Number(BigInt('0x' + d.slice(off, off + 64)));
  return Array.from({ length: n }, (_, i) => d.slice(off + 64 + i * 64, off + 128 + i * 64));
}
