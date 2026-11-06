/** Staking reads: what the node asks NodeStake and how it uses the answer.
 *  Pure — the caller does the eth_call. Chain: litVM Liteforge (4441).
 *
 *  Why this exists (BUILD-SPEC §2.2): operator and standing used to be
 *  self-asserted in the heartbeat. With a bond on chain, the operator IS the
 *  staking address and the standing IS the bonded amount, both read from the
 *  contract, so a witness "under a different operator" means a different
 *  staking address, and a node that has not posted the bond is not eligible
 *  for placement no matter what its heartbeat says. */
import { selector } from './keccak.js';
import { signRaw, fromHex } from './keys.js';

export const STANDING_OF = 'standingOf(bytes32)';

/** A node key is a 32-byte ed25519 public key — exactly a bytes32. */
export const nodeKeyBytes32 = (nodeIdHex) => {
  const h = nodeIdHex.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('nodeId must be a 32-byte hex key');
  return '0x' + h;
};

/** eth_call payload for standingOf(nodeKey). */
export const standingCall = (contract, nodeIdHex) => ({
  to: contract,
  data: selector(STANDING_OF) + nodeKeyBytes32(nodeIdHex).slice(2),
});

// ------------------------------------------------------------ writes (the cabinet builds these; the operator's wallet signs)
export const STAKE = 'stake(bytes32,uint256)';
export const TRANSFER_OPERATOR = 'transferOperator(bytes32,address)';
export const UNSTAKE = 'unstake(bytes32)';
export const WITHDRAW = 'withdraw(bytes32)';
export const MIN_STAKE = 'minStake()';
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => { const h = String(a).replace(/^0x/, '').toLowerCase(); if (!/^[0-9a-f]{40}$/.test(h)) throw new Error('bad address'); return h.padStart(64, '0'); };
export const minStakeCall = (contract) => ({ to: contract, data: selector(MIN_STAKE) });
export const stakeCalldata = (nodeIdHex, amountWei) => selector(STAKE) + nodeKeyBytes32(nodeIdHex).slice(2) + uintWord(amountWei);
export const transferOperatorCalldata = (nodeIdHex, to) => selector(TRANSFER_OPERATOR) + nodeKeyBytes32(nodeIdHex).slice(2) + addrWord(to);
export const unstakeCalldata = (nodeIdHex) => selector(UNSTAKE) + nodeKeyBytes32(nodeIdHex).slice(2);
export const withdrawCalldata = (nodeIdHex) => selector(WITHDRAW) + nodeKeyBytes32(nodeIdHex).slice(2);
/** The stake token (TestLITVM on testnet): approve the stake contract, and the open faucet. */
export const approveCalldata = (spender, amountWei) => selector('approve(address,uint256)') + addrWord(spender) + uintWord(amountWei);
export const faucetCalldata = () => selector('faucet()');
export const balanceOfCall = (token, address) => ({ to: token, data: selector('balanceOf(address)') + addrWord(address) });

/** Decode (address operator, uint256 amount, bool active). */
export function decodeStanding(hex) {
  const d = hex.replace(/^0x/, '');
  if (d.length < 192) throw new Error('short standingOf result');
  return {
    operator: '0x' + d.slice(24, 64),
    amount: BigInt('0x' + d.slice(64, 128)),
    active: BigInt('0x' + d.slice(128, 192)) === 1n,
  };
}

/** Overlay on-chain standing onto gossiped peers. A peer with no active
 *  bond is dropped; `operator` and `standing` are REPLACED by chain values so
 *  nothing self-asserted survives into placement. `standing` is the bonded
 *  amount in whole tokens (18 decimals), so manifests can set a floor in
 *  tokens. `stakes` maps nodeId → decoded standing (missing = not staked). */
export function applyStakes(peers, stakes) {
  const out = [];
  for (const p of peers) {
    const s = stakes[p.nodeId];
    if (!s || !s.active) continue;
    // `eligible` (NodeStake v3 witnessEligible) gates the witness panel; absent on a v2 contract → the panel draw treats the node as eligible.
    out.push({ ...p, operator: s.operator.toLowerCase(), standing: Number(s.amount / 10n ** 18n), staked: true, ...(typeof s.eligible === 'boolean' ? { eligible: s.eligible } : {}) });
  }
  return out;
}

// ------------------------------------------------------------ v3: lock, eligibility, delegate (BUILD-SPEC v0.3 §2.2)
export const NODE_OF = 'nodeOf(bytes32)';
export const WITNESS_ELIGIBLE = 'witnessEligible(bytes32)';
export const DELEGATE_OF = 'delegateOf(bytes32)';
export const SET_DELEGATE = 'setDelegate(bytes32,address)';
export const ADMIN_IS_CONTRACT = 'adminIsContract()';
export const MAY_ACT_FOR = 'mayActFor(bytes32,address)';
export const mayActForCall = (contract, nodeIdHex, who) => ({ to: contract, data: selector(MAY_ACT_FOR) + nodeKeyBytes32(nodeIdHex).slice(2) + addrWord(who) });
export const nodeOfCall = (contract, nodeIdHex) => ({ to: contract, data: selector(NODE_OF) + nodeKeyBytes32(nodeIdHex).slice(2) });
export const witnessEligibleCall = (contract, nodeIdHex) => ({ to: contract, data: selector(WITNESS_ELIGIBLE) + nodeKeyBytes32(nodeIdHex).slice(2) });
export const delegateOfCall = (contract, nodeIdHex) => ({ to: contract, data: selector(DELEGATE_OF) + nodeKeyBytes32(nodeIdHex).slice(2) });
export const adminIsContractCall = (contract) => ({ to: contract, data: selector(ADMIN_IS_CONTRACT) });
/** The operator's wallet signs this: name the hot key the node runs with. */
export const setDelegateCalldata = (nodeIdHex, delegate) => selector(SET_DELEGATE) + nodeKeyBytes32(nodeIdHex).slice(2) + addrWord(delegate);
export const decodeBool = (hex) => BigInt('0x' + (hex.replace(/^0x/, '') || '0')) === 1n;
/** Decode nodeOf: (operator, delegate, amount, bondedSince, unbondAt, active, eligible). A v2
 *  contract answers standingOf-shaped data or reverts; the caller labels the read. */
export function decodeNode(hex) {
  const d = hex.replace(/^0x/, '');
  if (d.length < 448) throw new Error('short nodeOf result');
  const word = (i) => d.slice(i * 64, (i + 1) * 64);
  const zero = '0x0000000000000000000000000000000000000000';
  const addr = (i) => { const a = '0x' + word(i).slice(24); return a === zero ? null : a; };
  return {
    operator: addr(0), delegate: addr(1), amount: BigInt('0x' + word(2)),
    bondedSince: Number(BigInt('0x' + word(3))), unbondAt: Number(BigInt('0x' + word(4))),
    active: BigInt('0x' + word(5)) === 1n, eligible: BigInt('0x' + word(6)) === 1n,
  };
}

// ------------------------------------------------------------ v4: proof of key (generation 4, audit 2026-10-21 §4.2 finding 1)
/** A generation-4 NodeStake binds a key only with the key's own signature:
 *  bond(nodeKey, amount, sig) where sig is ed25519 by the node key over
 *  bondMessage(chainId, NodeStake, operator). stake() then only tops up a
 *  key that is already bound. version() answers 4; generation 3 reverts. */
export const BOND = 'bond(bytes32,uint256,bytes)';
export const VERSION = 'version()';
export const BOND_TAG = 'litnode-bond-v1';
export const versionCall = (contract) => ({ to: contract, data: selector(VERSION) });
/** A version() answer → the generation number; null for an empty or failed read (generation 3 has no version()). */
export const decodeVersion = (hex) => { const d = String(hex ?? '').replace(/^0x/, ''); return /^[0-9a-f]{64}/i.test(d) ? Number(BigInt('0x' + d.slice(0, 64))) : null; };

/** The exact bytes the node key signs: "litnode-bond-v1" ‖ 0x00 ‖ uint256 chainId ‖ address NodeStake ‖ address operator
 *  (88 bytes; NodeStake.bondMessage(operator) returns the same bytes). */
export function bondMessage(chainId, contractAddr, operatorAddr) {
  const tag = new TextEncoder().encode(BOND_TAG);
  const out = new Uint8Array(tag.length + 1 + 32 + 20 + 20);
  out.set(tag, 0);
  out[tag.length] = 0;
  out.set(fromHex(uintWord(chainId)), tag.length + 1);
  out.set(fromHex(addrWord(contractAddr).slice(24)), tag.length + 33);
  out.set(fromHex(addrWord(operatorAddr).slice(24)), tag.length + 53);
  return out;
}

/** The node's proof: its key signs bondMessage. Hex, 64 bytes. */
export const bondProof = (privateKeyHex, chainId, contractAddr, operatorAddr) => signRaw(bondMessage(chainId, contractAddr, operatorAddr), privateKeyHex);

/** bond(bytes32 nodeKey, uint256 amount, bytes sig) calldata. */
export function bondCalldata(nodeIdHex, amountWei, sigHex) {
  const sig = String(sigHex).replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(sig)) throw new Error('bond proof must be a 64-byte signature');
  return selector(BOND) + nodeKeyBytes32(nodeIdHex).slice(2) + uintWord(amountWei) + uintWord(96) + uintWord(64) + sig;
}
