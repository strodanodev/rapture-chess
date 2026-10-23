/**
 * The LitNodeWager escrow from the browser: zkLTC stakes bound to a LitNode player key, paid out on the host
 * node's signed delta. No signing or resolver here: the client sends through the Deckwright wallet, and the
 * proof is LitNode's own (`GET <node>/delta/<matchId>`), re-serialised exactly as the node signed it.
 *
 *   claim(matchId, deltaJson, hostSig)   deltaJson = canonical(delta without hostSig/cosigners/cosigs/disputes)
 *                                        hostSig   = the delta's hostSig (64 bytes, ed25519 by the host node)
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, encodeCall, utf8ToHex, words, uintAt, addressAt, boolAt } from 'deckwright/web/lib/abi.js';
import type { ChainClient } from 'deckwright/web/lib/chain.js';
import { canonical } from './canonical';

export { canonical };

export const LITEFORGE_CHAIN_ID = 4441;
export const CHESS_RULESET_ID = 'rapture-chess.v1';

/** Human-readable ABI of what the client calls or reads. */
export const WAGER_ABI = [
  'function stake(bytes32 playerKey) payable',
  'function requestUnstake()',
  'function unstake()',
  'function claim(bytes32 matchId, bytes deltaJson, bytes hostSig)',
  'function withdraw()',
  'function stakeOf(address wallet) view returns (uint256 amount, uint64 unstakeAt)',
  'function keyOf(address wallet) view returns (bytes32)',
  'function walletOf(bytes32 key) view returns (address)',
  'function claimed(bytes32 matchId) view returns (bool)',
  'function pending(address) view returns (uint256)',
  'function unstakeDelay() view returns (uint64)',
  'function feeBps() view returns (uint16)',
  'event Staked(address indexed wallet, bytes32 indexed key, uint256 amount, uint256 total)',
  'event UnstakeRequested(address indexed wallet, uint64 at)',
  'event Unstaked(address indexed wallet, uint256 amount)',
  'event Claimed(bytes32 indexed matchId, bytes32 indexed hostKey, bytes32 keyA, bytes32 keyB, uint256 pot, address winner, uint256 fee)',
  'event PaymentHeld(address indexed to, uint256 amount)',
  'event Withdrawn(address indexed to, uint256 amount)',
] as const;

// ------------------------------------------------------------------ ids
const HEX64 = /^[0-9a-f]{64}$/;
/** A LitNode id (player key, node key, match id): 64 lowercase hex characters, no 0x. */
export const isLitId = (s: unknown): s is string => typeof s === 'string' && HEX64.test(s);
/** A LitNode id as the bytes32 the contract takes. */
export function litIdToBytes32(id: string): string {
  const s = String(id).replace(/^0x/, '').toLowerCase();
  if (!HEX64.test(s)) throw new TypeError('expected a 64-hex LitNode id');
  return `0x${s}`;
}
export const isBytes32 = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);

// ------------------------------------------------------------------ the claim
/** The settled delta as a node serves it (GET /delta/:id): the signed body plus the node's attachments. */
export interface LitNodeDelta {
  matchId: string;
  rulesetId: string;
  hostId: string;
  hostSig: string;
  participants: string[];
  scores: Record<string, number>;
  attestation: string;
  complete?: boolean;
  resultHash: string;
  placed?: boolean;
  mode?: string;
  cosigners?: string[];
  cosigs?: Record<string, string>;
  disputes?: unknown[];
  verification?: string;
  official?: boolean;
  [k: string]: unknown;
}

/** What the escrow verifies: the canonical bytes the host signed, and its signature. */
export function deltaClaimBytes(delta: LitNodeDelta): { json: string; hostSig: string } {
  const { hostSig, cosigners: _c, cosigs: _s, disputes: _d, verification: _v, official: _o, ...body } = delta;
  if (!/^[0-9a-f]{128}$/.test(hostSig ?? '')) throw new Error('the delta carries no host signature');
  return { json: canonical(body), hostSig: `0x${hostSig}` };
}

/** Why a delta could not pay out, before spending gas; null when it looks claimable. */
export function claimProblem(delta: LitNodeDelta, matchId: string): string | null {
  if (delta.matchId !== matchId) return 'the delta is for another match';
  if (delta.rulesetId !== CHESS_RULESET_ID) return `the delta is for ${delta.rulesetId}, not ${CHESS_RULESET_ID}`;
  if (delta.attestation !== 'players') return `the result is ${delta.attestation}-attested: both players must have signed the ledger`;
  if (delta.complete === false) return 'the match did not finish';
  if (!Array.isArray(delta.participants) || delta.participants.length !== 2 || !delta.participants.every(isLitId)) return 'the delta names no two player keys';
  if (!delta.scores || delta.participants.some((p) => typeof delta.scores[p] !== 'number')) return 'the delta carries no scores';
  return null;
}

/** 0 side 0 wins, 1 side 1 wins, 2 draw, as the board numbers it. */
export function deltaWinner(delta: LitNodeDelta): 0 | 1 | 2 {
  const [a, b] = delta.participants;
  const sa = delta.scores[a] ?? 0, sb = delta.scores[b] ?? 0;
  return sa === sb ? 2 : sa > sb ? 0 : 1;
}

// ------------------------------------------------------------------ calldata
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const keccak = (bytes: Uint8Array): string => bytesToHex(keccak_256(bytes));
export const selector = (signature: string): string => `0x${keccak(utf8(signature)).slice(2, 10)}`;
export const SELECTORS = {
  stake: selector('stake(bytes32)'),
  requestUnstake: selector('requestUnstake()'),
  unstake: selector('unstake()'),
  claim: selector('claim(bytes32,bytes,bytes)'),
  withdraw: selector('withdraw()'),
  stakeOf: selector('stakeOf(address)'),
  keyOf: selector('keyOf(address)'),
  walletOf: selector('walletOf(bytes32)'),
  claimed: selector('claimed(bytes32)'),
  pending: selector('pending(address)'),
  unstakeDelay: selector('unstakeDelay()'),
  feeBps: selector('feeBps()'),
};

// Deckwright's encoder has no bytes32 type: a bytes32 is a uint256 word, so it is passed as such.
const b32 = (hex: string): bigint => { if (!isBytes32(hex)) throw new TypeError('expected bytes32'); return BigInt(hex); };

export const encodeStake = (playerKey: string): string => encodeCall(SELECTORS.stake, ['uint256'], [b32(litIdToBytes32(playerKey))]);
export const encodeRequestUnstake = (): string => SELECTORS.requestUnstake;
export const encodeUnstake = (): string => SELECTORS.unstake;
export const encodeWithdraw = (): string => SELECTORS.withdraw;
export const encodeClaim = (matchId: string, json: string, hostSig: string): string =>
  encodeCall(SELECTORS.claim, ['uint256', 'bytes', 'bytes'], [b32(litIdToBytes32(matchId)), utf8ToHex(json), hostSig]);

// ------------------------------------------------------------------ reads
export interface StakeRecord { amount: bigint; unstakeAt: number; key: string | null }

export async function readStake(chain: ChainClient, contract: string, wallet: string): Promise<StakeRecord> {
  const [s, k] = await Promise.all([
    chain.call({ to: contract, data: encodeCall(SELECTORS.stakeOf, ['address'], [wallet]) }),
    chain.call({ to: contract, data: encodeCall(SELECTORS.keyOf, ['address'], [wallet]) }),
  ]);
  const ws = words(s);
  const key = words(k)[0] ?? '';
  return { amount: uintAt(ws, 0), unstakeAt: Number(uintAt(ws, 1)), key: /^0+$/.test(key) ? null : key };
}
export async function readWalletOf(chain: ChainClient, contract: string, playerKey: string): Promise<string> {
  return addressAt(words(await chain.call({ to: contract, data: encodeCall(SELECTORS.walletOf, ['uint256'], [b32(litIdToBytes32(playerKey))]) })), 0);
}
export async function readClaimed(chain: ChainClient, contract: string, matchId: string): Promise<boolean> {
  return boolAt(words(await chain.call({ to: contract, data: encodeCall(SELECTORS.claimed, ['uint256'], [b32(litIdToBytes32(matchId))]) })), 0);
}
export async function readPending(chain: ChainClient, contract: string, wallet: string): Promise<bigint> {
  return uintAt(words(await chain.call({ to: contract, data: encodeCall(SELECTORS.pending, ['address'], [wallet]) })), 0);
}
export async function readUnstakeDelay(chain: ChainClient, contract: string): Promise<number> {
  return Number(uintAt(words(await chain.call({ to: contract, data: SELECTORS.unstakeDelay })), 0));
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
