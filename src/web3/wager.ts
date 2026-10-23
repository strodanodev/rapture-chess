/**
 * The ChessWager escrow, shared by the browser client and the relay: ids and hashes (the single definition of
 * matchId, seedCommit and logHash), the EIP-712 settlement typed data, the minimal ABI and calldata builders.
 * No signing or sending here: the client sends through the Deckwright wallet, the relay signs with ethers.
 *
 *   matchId    = keccak256(seed)                                     seed: 32 random bytes the creator reveals to the relay
 *   seedCommit = keccak256("rapture-chess/seed/v1" ‖ seed)           abi.encodePacked(string, bytes32)
 *   logHash    = keccak256(abi.encode(bytes32 seed, int32[] inputs)) inputs flattened: e0.side0, e0.side1, e1.side0, …
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, encodeCall, words, uintAt, addressAt } from 'deckwright/web/lib/abi.js';
import type { ChainClient } from 'deckwright/web/lib/chain.js';
import type { LogEntry } from '../game/session';

export const SEED_DOMAIN = 'rapture-chess/seed/v1';
export const WAGER_DOMAIN_NAME = 'RaptureChessWager';
export const WAGER_DOMAIN_VERSION = '1';
export const LITEFORGE_CHAIN_ID = 4441;

/** Human-readable ABI of what the client and relay call or read. */
export const WAGER_ABI = [
  'function createMatch(bytes32 matchId, bytes32 seedCommit) payable',
  'function joinMatch(bytes32 matchId) payable',
  'function settle(bytes32 matchId, uint8 winner, bytes32 logHash, bytes resolverSig)',
  'function cancel(bytes32 matchId)',
  'function timeoutClaim(bytes32 matchId)',
  'function withdraw()',
  'function matches(bytes32) view returns (address creator, address joiner, uint96 stake, uint64 createdAt, uint64 joinedAt, uint8 status, uint8 winner, bytes32 seedCommit, bytes32 logHash)',
  'function pending(address) view returns (uint256)',
  'function resolver() view returns (address)',
  'function feeBps() view returns (uint16)',
  'function settleTimeout() view returns (uint64)',
  'event MatchCreated(bytes32 indexed matchId, address indexed creator, uint256 stake, bytes32 seedCommit)',
  'event MatchJoined(bytes32 indexed matchId, address indexed joiner)',
  'event MatchSettled(bytes32 indexed matchId, uint8 winner, bytes32 logHash, uint256 payout, uint256 fee)',
  'event MatchCancelled(bytes32 indexed matchId)',
  'event MatchTimedOut(bytes32 indexed matchId, address indexed by)',
] as const;

export const MatchStatus = { None: 0, Open: 1, Live: 2, Settled: 3, Cancelled: 4, TimedOut: 5 } as const;
export type MatchStatusCode = typeof MatchStatus[keyof typeof MatchStatus];
export const STATUS_NAME: Record<number, string> = { 0: 'none', 1: 'open', 2: 'live', 3: 'settled', 4: 'cancelled', 5: 'timed out' };

/** 0 creator (Alliance), 1 joiner (Horde), 2 draw: the same numbering as the chess state's `winner`. */
export type Winner = 0 | 1 | 2;

export interface Settlement { matchId: string; winner: Winner; logHash: string; sig: string }

// ------------------------------------------------------------------ hashing
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
export const keccak = (bytes: Uint8Array): string => bytesToHex(keccak_256(bytes));

export function isBytes32(s: unknown): s is string { return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s); }

/** 32 random bytes as 0x hex (browser or Node 22 `globalThis.crypto`). */
export function randomSeed(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

export function matchIdOf(seed: string): string {
  if (!isBytes32(seed)) throw new TypeError('seed must be 32 bytes of 0x hex');
  return keccak(hexToBytes(seed));
}

export function seedCommitOf(seed: string): string {
  if (!isBytes32(seed)) throw new TypeError('seed must be 32 bytes of 0x hex');
  return keccak(concat(utf8(SEED_DOMAIN), hexToBytes(seed)));
}

const word = (hex: string): string => hex.slice(2).toLowerCase().padStart(64, '0');
/** int32 as a 256-bit two's complement word. */
const int32Word = (n: number): string => {
  const v = BigInt(n | 0);
  return (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, '0');
};

/** keccak256(abi.encode(bytes32 seed, int32[] inputs)) over the match log. */
export function logHashOf(seed: string, entries: ReadonlyArray<Pick<LogEntry, 'inputs'>>): string {
  if (!isBytes32(seed)) throw new TypeError('seed must be 32 bytes of 0x hex');
  const flat = entries.flatMap((e) => [e.inputs[0] | 0, e.inputs[1] | 0]);
  const hex = word(seed) + int32Word(0x40) + int32Word(flat.length) + flat.map(int32Word).join('');
  return keccak(hexToBytes(`0x${hex}`));
}

// ------------------------------------------------------------------ EIP-712
export const SETTLEMENT_TYPES = {
  Settlement: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'winner', type: 'uint8' },
    { name: 'logHash', type: 'bytes32' },
  ],
} as const;

export function settlementDomain(verifyingContract: string, chainId = LITEFORGE_CHAIN_ID) {
  return { name: WAGER_DOMAIN_NAME, version: WAGER_DOMAIN_VERSION, chainId, verifyingContract };
}

// ------------------------------------------------------------------ calldata
export const selector = (signature: string): string => `0x${keccak(utf8(signature)).slice(2, 10)}`;
export const SELECTORS = {
  createMatch: selector('createMatch(bytes32,bytes32)'),
  joinMatch: selector('joinMatch(bytes32)'),
  settle: selector('settle(bytes32,uint8,bytes32,bytes)'),
  cancel: selector('cancel(bytes32)'),
  timeoutClaim: selector('timeoutClaim(bytes32)'),
  withdraw: selector('withdraw()'),
  matches: selector('matches(bytes32)'),
  pending: selector('pending(address)'),
  resolver: selector('resolver()'),
  settleTimeout: selector('settleTimeout()'),
};

// Deckwright's encoder has no bytes32 type: a bytes32 is a uint256 word, so we pass it as such.
const b32 = (hex: string): bigint => { if (!isBytes32(hex)) throw new TypeError('expected bytes32'); return BigInt(hex); };

export const encodeCreateMatch = (matchId: string, seedCommit: string): string => encodeCall(SELECTORS.createMatch, ['uint256', 'uint256'], [b32(matchId), b32(seedCommit)]);
export const encodeJoinMatch = (matchId: string): string => encodeCall(SELECTORS.joinMatch, ['uint256'], [b32(matchId)]);
export const encodeSettle = (s: Settlement): string => encodeCall(SELECTORS.settle, ['uint256', 'uint8', 'uint256', 'bytes'], [b32(s.matchId), s.winner, b32(s.logHash), s.sig]);
export const encodeCancel = (matchId: string): string => encodeCall(SELECTORS.cancel, ['uint256'], [b32(matchId)]);
export const encodeTimeoutClaim = (matchId: string): string => encodeCall(SELECTORS.timeoutClaim, ['uint256'], [b32(matchId)]);
export const encodeWithdraw = (): string => SELECTORS.withdraw;

// ------------------------------------------------------------------ reads
export interface MatchRecord {
  creator: string; joiner: string; stake: bigint; createdAt: number; joinedAt: number; status: number; winner: number; seedCommit: string; logHash: string;
}

export function decodeMatch(data: string): MatchRecord {
  const ws = words(data);
  if (ws.length < 9) throw new Error('matches(): short response');
  return {
    creator: addressAt(ws, 0), joiner: addressAt(ws, 1), stake: uintAt(ws, 2), createdAt: Number(uintAt(ws, 3)), joinedAt: Number(uintAt(ws, 4)),
    status: Number(uintAt(ws, 5)), winner: Number(uintAt(ws, 6)), seedCommit: `0x${ws[7]}`, logHash: `0x${ws[8]}`,
  };
}

export async function readMatch(chain: ChainClient, contract: string, matchId: string): Promise<MatchRecord> {
  return decodeMatch(await chain.call({ to: contract, data: encodeCall(SELECTORS.matches, ['uint256'], [b32(matchId)]) }));
}

export async function readPending(chain: ChainClient, contract: string, address: string): Promise<bigint> {
  return uintAt(words(await chain.call({ to: contract, data: encodeCall(SELECTORS.pending, ['address'], [address]) })), 0);
}

// ------------------------------------------------------------------ amounts
const WEI = 10n ** 18n;
/** "0.25" zkLTC -> wei (up to 18 decimals). */
export function parseZkLtc(text: string): bigint {
  const m = /^\s*(\d+)(?:\.(\d{1,18}))?\s*$/.exec(text);
  if (!m) throw new Error('enter an amount like 0.5');
  return BigInt(m[1]) * WEI + BigInt((m[2] ?? '').padEnd(18, '0'));
}
export function formatZkLtc(wei: bigint, decimals = 4): string {
  const whole = wei / WEI, frac = (wei % WEI).toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
