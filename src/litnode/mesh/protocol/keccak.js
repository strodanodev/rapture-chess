/** keccak256 — the hash the chain commits with. Dependency-free so the same
 *  bytes hash identically in a browser, a node and Solidity. Used for
 *  soulManifestHash (contract: keccak256(SOUL.MD)) and for function selectors,
 *  so the sha256-here / keccak-there mismatch listed in BUILD-SPEC §8.2 is
 *  closed by construction. BigInt lanes: simple and correct, fast enough for
 *  the few kilobytes a node hashes with it. */

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offsets indexed [x + 5*y].
const ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];
const M64 = (1n << 64n) - 1n;
const rotl = (a, n) => (n === 0 ? a : (((a << BigInt(n)) | (a >> BigInt(64 - n))) & M64));

function keccakF(A) {
  const C = new Array(5), D = new Array(5), B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    for (let i = 0; i < 25; i++) A[i] ^= D[i % 5];
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[(x + 1) % 5 + 5 * y] & M64 & B[(x + 2) % 5 + 5 * y]);
    A[0] ^= RC[round];
  }
}

/** keccak256 of a string (UTF-8) or Uint8Array → lowercase hex, no 0x. */
export function keccak256Hex(input) {
  const msg = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const RATE = 136;
  const padLen = (Math.floor(msg.length / RATE) + 1) * RATE;
  const p = new Uint8Array(padLen);
  p.set(msg);
  p[msg.length] ^= 0x01;
  p[padLen - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padLen; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(p[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  let out = '';
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) { out += Number(lane & 0xffn).toString(16).padStart(2, '0'); lane >>= 8n; }
  }
  return out;
}

/** 4-byte Solidity function selector, e.g. selector('anchorEpoch(uint64,bytes32)'). */
export const selector = (signature) => '0x' + keccak256Hex(signature).slice(0, 8);
