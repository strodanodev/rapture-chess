/** NodeDirectory reads and the one write a node makes. Pure — the caller
 *  does the eth_call / eth_sendRawTransaction. contracts/NodeDirectory.sol.
 *
 *  Readers: the key list → entryOf(key) for each → keep those whose NodeStake
 *  standing is active and whose entry is fresh. That list is the mesh's
 *  bootstrap: what a fresh install seeds from and what the hosted arcade
 *  page reads when the visitor has no node.
 *
 *  The key list: generation 4 pages it (keysPage(offset, limit)); generation
 *  3 has only the whole keys(). readDirectoryKeys tries the page and falls
 *  back. The per-key reads go through a bounded pool (mapLimit) — the
 *  Liteforge gateway answers 429 past ~25 requests a second, and a fan-out
 *  of 2×N parallel eth_calls made the arcade fail closed to "No seed has
 *  announced" (audit 2026-10-21 §4.2 finding 2). */
import { selector } from './keccak.js';
import { nodeKeyBytes32 } from './staking.js';
import { encodeBytes32StringString, decodeStringStringUintAddress, decodeBytes32Array } from './abi.js';

export const ANNOUNCE = 'announce(bytes32,string,string)';
export const ENTRY_OF = 'entryOf(bytes32)';
export const KEYS = 'keys()';
export const KEYS_PAGE = 'keysPage(uint256,uint256)';
export const COUNT = 'count()';
/** Keys per keysPage read. */
export const PAGE = 100;
/** Per-key reads in flight at once (each seed is two eth_calls: entry + standing). */
export const READ_CONCURRENCY = 4;
export const SET_ANNOUNCER = 'setAnnouncer(bytes32,address)';
export const ANNOUNCER_OF = 'announcerOf(bytes32)';
/** An entry older than this is not a seed any more (the node stopped announcing). */
export const FRESH_S = 7 * 24 * 3600;

export const keysCall = (contract) => ({ to: contract, data: selector(KEYS) });
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
export const keysPageCall = (contract, offset, limit) => ({ to: contract, data: selector(KEYS_PAGE) + word(offset) + word(limit) });
export const countCall = (contract) => ({ to: contract, data: selector(COUNT) });
export const entryOfCall = (contract, nodeKeyHex) => ({ to: contract, data: selector(ENTRY_OF) + nodeKeyBytes32(nodeKeyHex).slice(2) });
export const announcerOfCall = (contract, nodeKeyHex) => ({ to: contract, data: selector(ANNOUNCER_OF) + nodeKeyBytes32(nodeKeyHex).slice(2) });
export const decodeKeys = decodeBytes32Array;
export const decodeEntry = decodeStringStringUintAddress;
export const decodeAddress = (hex) => '0x' + hex.replace(/^0x/, '').slice(24, 64);

export const announceCalldata = (nodeKeyHex, url, wsAddr = '') => selector(ANNOUNCE) + encodeBytes32StringString(nodeKeyBytes32(nodeKeyHex).slice(2), url, wsAddr);
export const setAnnouncerCalldata = (nodeKeyHex, announcer) => selector(SET_ANNOUNCER) + nodeKeyBytes32(nodeKeyHex).slice(2) + announcer.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** Fold raw reads into the seed list a client uses. `stakes` maps key → {active}. */
export function liveSeeds(entries, stakes, nowS = Math.floor(Date.now() / 1000)) {
  return Object.entries(entries)
    .filter(([k, e]) => e.url && stakes?.[k]?.active && nowS - e.updatedAt <= FRESH_S)
    .map(([nodeId, e]) => ({ nodeId, url: e.url, wsAddr: e.wsAddr || null, updatedAt: e.updatedAt, operator: stakes[nodeId].operator }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Every announced key, paged (generation 4) or whole (generation 3, which has no keysPage).
 *  `call(payload)` does one eth_call and returns its hex; it throws on a revert. */
export async function readDirectoryKeys(call, contract, { page = PAGE } = {}) {
  // A real keysPage answer is an ABI array (≥ 64 bytes, even when empty); a revert, or the bare "0x" some
  // gateways return for an unknown selector, means generation 3: read the whole list instead.
  const whole = async () => decodeBytes32Array(await call(keysCall(contract)));
  let first;
  try {
    const ret = String(await call(keysPageCall(contract, 0, page)) ?? '');
    if (ret.replace(/^0x/, '').length < 128) return whole();
    first = decodeBytes32Array(ret);
  } catch { return whole(); }
  const keys = [...first];
  for (let got = first.length; got === page; ) {
    const next = decodeBytes32Array(await call(keysPageCall(contract, keys.length, page)));
    keys.push(...next); got = next.length;
  }
  return keys;
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
