/**
 * The live Rapture ARC 1 pack shop (PackShop v1 on Liteforge) from the chess client: read the shop, buy a sealed pack,
 * open it once its reveal block is mined, and find a wallet's unopened packs again after a reload.
 *
 * v1 draws from the blockhash of the block after the purchase, so a pack opens a block or two after `buyPack` and must
 * be opened inside 255 blocks; past that it can only be refunded. Liteforge is Arbitrum Nitro, so the contract's
 * block.number is not the RPC's: readiness is the contract's own `phaseOf`/`recentPacks`, never block arithmetic here.
 */
import { encodeCall, words, uintAt, boolAt, extractRevertData } from 'tessaract/web/lib/abi.js';
import type { ChainClient } from 'tessaract/web/lib/chain.js';
import type { Wallet } from 'tessaract/web/lib/wallet.js';

export const PACKSHOP = '0x3E39be64A4dE8752E45067d6Bbe4787b4D272B0c';
/** Odds weights in contract order. */
export const KIND_ORDER = ['Mortal', 'King', 'Demigod', 'Titan', 'God'] as const;
export enum Phase { None, Waiting, Openable, Expired, Opened, Refunded }

const SEL = {
  config: '0x79502c55', packsLeftToday: '0x9d3a3ee5', recentPacks: '0xd3ee9e8d',
  buyPack: '0xc37b9bcd', openPack: '0x50a88c7e', refundExpired: '0x1402b17a',
};
const TOPIC = {
  bought: '0x903fd5359768866b00d366f17280045a07752297ccbb24e26a6e2ebed4f00262',
  opened: '0x30586b2d3dad0c3599ca4232dee054c6422b872e33ef40f0d117c0c35e1f583d',
};
const ERRORS: Record<string, string> = {
  '0x085de625': 'TooEarly', '0x203d82d8': 'Expired', '0xc1f31ec9': 'NotSealed', '0x788a686f': 'WrongPayment', '0x5a0998b5': 'NotStocked',
  '0xf402e5b1': 'DailyLimitReached', '0xd93c0665': 'Paused',
};
const PLAIN: Record<string, string> = {
  Expired: 'This pack waited too long to open and can only be refunded now.',
  WrongPayment: 'The pack price just changed. Reload and try again.',
  NotStocked: 'The shop is restocking. Try again later.',
  DailyLimitReached: 'You have bought today\'s packs. The forge reopens at midnight UTC.',
  Paused: 'The shop is closed for now.',
  NotSealed: 'That pack was already opened.',
};

export interface ShopConfig { price: bigint; packSize: number; dailyLimit: number; paused: boolean; ready: boolean; weights: number[]; templates: number }
export interface PackRef { id: bigint; phase: Phase }

type TxChain = ChainClient & { estimateGas(tx: Record<string, unknown>): Promise<bigint>; getBalance(address: string): Promise<bigint> };

export function revertName(e: unknown): string | null {
  const data = extractRevertData(e);
  return data ? ERRORS[data.slice(0, 10)] ?? null : null;
}
export function shopMessage(e: unknown): string {
  const n = revertName(e);
  if (n && PLAIN[n]) return PLAIN[n];
  const m = (e as Error)?.message ?? String(e);
  if (/reject|denied|cancel/i.test(m)) return 'You cancelled in your wallet. Nothing was spent.';
  return m.length > 160 ? `${m.slice(0, 157)}…` : m;
}

export async function readShop(chain: ChainClient): Promise<ShopConfig> {
  const w = words(await chain.call({ to: PACKSHOP, data: SEL.config }));
  return {
    price: uintAt(w, 0), packSize: Number(uintAt(w, 1)), dailyLimit: Number(uintAt(w, 2)), paused: boolAt(w, 3), ready: boolAt(w, 4),
    weights: [5, 6, 7, 8, 9].map((i) => Number(uintAt(w, i))), templates: Number(uintAt(w, 10)),
  };
}

export async function packsLeftToday(chain: ChainClient, who: string): Promise<number> {
  const v = uintAt(words(await chain.call({ to: PACKSHOP, data: encodeCall(SEL.packsLeftToday, ['address'], [who]) })), 0);
  return v > 1_000_000n ? Infinity : Number(v);
}

/** The wallet's latest packs (at most 16), oldest first. */
export async function recentPacks(chain: ChainClient, who: string): Promise<PackRef[]> {
  const w = words(await chain.call({ to: PACKSHOP, data: encodeCall(SEL.recentPacks, ['address', 'uint256'], [who, 16n]) }));
  // three dynamic arrays: heads at words 0..2 are byte offsets
  const at = (head: number) => Number(uintAt(w, head)) / 32;
  const ids = at(0), phases = at(1);
  const n = Number(uintAt(w, ids));
  return Array.from({ length: n }, (_, i) => ({ id: uintAt(w, ids + 1 + i), phase: Number(uintAt(w, phases + 1 + i)) as Phase }));
}

/** Buy one pack; resolves its id once the purchase is mined. */
export async function buyPack(wallet: Wallet, chain: ChainClient, price: bigint, onStage: (s: string) => void): Promise<bigint> {
  await wallet.ensureChain();
  const from = wallet.snapshot().address!;
  const c = chain as TxChain;
  try { await c.estimateGas({ from, to: PACKSHOP, data: SEL.buyPack, value: price }); } catch (e) { throw new Error(shopMessage(e)); }
  onStage('Confirm the purchase in your wallet');
  let hash: string;
  try { hash = await wallet.sendTransaction({ to: PACKSHOP, data: SEL.buyPack, value: price }); } catch (e) { throw new Error(shopMessage(e)); }
  onStage('Sealing your pack on Liteforge');
  const rc = await chain.waitForReceipt(hash, { timeoutMs: 120_000 });
  if (Number(rc.status) !== 1) throw new Error('The purchase reverted. Nothing was charged beyond gas.');
  const log = (rc.logs as Array<{ address: string; topics: string[] }> | undefined)?.find((l) => l.address.toLowerCase() === PACKSHOP.toLowerCase() && l.topics[0] === TOPIC.bought);
  if (!log) throw new Error('The purchase landed but its pack id was not in the receipt. Reopen the shop to find it.');
  return BigInt(log.topics[1]);
}

/** Open a sealed pack: waits (politely polling) until its reveal block exists, then mints. Resolves the new token ids. */
export async function openPack(wallet: Wallet, chain: ChainClient, packId: bigint, onStage: (s: string) => void, signal?: AbortSignal): Promise<string[]> {
  const from = wallet.snapshot().address!;
  const data = encodeCall(SEL.openPack, ['uint256'], [packId]);
  const c = chain as TxChain;
  onStage('Waiting for the reveal block');
  for (let i = 0; ; i++) {
    if (signal?.aborted) throw new Error('Cancelled.');
    try { await c.estimateGas({ from, to: PACKSHOP, data }); break; } catch (e) {
      const n = revertName(e);
      if (n !== 'TooEarly' || i > 60) throw new Error(shopMessage(e));
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  onStage('Confirm the opening in your wallet');
  let hash: string;
  try { hash = await wallet.sendTransaction({ to: PACKSHOP, data }); } catch (e) { throw new Error(shopMessage(e)); }
  onStage('The forge is minting your champions');
  const rc = await chain.waitForReceipt(hash, { timeoutMs: 180_000 });
  if (Number(rc.status) !== 1) throw new Error('Opening reverted. The pack is still sealed: try again.');
  const log = (rc.logs as Array<{ address: string; topics: string[]; data: string }> | undefined)?.find((l) => l.address.toLowerCase() === PACKSHOP.toLowerCase() && l.topics[0] === TOPIC.opened);
  if (!log) return [];
  // data: uint256[] tokenIds, uint16[] templateIds (two dynamic arrays)
  const w = words(log.data);
  const off = Number(uintAt(w, 0)) / 32;
  const n = Number(uintAt(w, off));
  return Array.from({ length: n }, (_, i) => uintAt(w, off + 1 + i).toString());
}

export async function refundPack(wallet: Wallet, chain: ChainClient, packId: bigint): Promise<void> {
  await wallet.ensureChain();
  const hash = await wallet.sendTransaction({ to: PACKSHOP, data: encodeCall(SEL.refundExpired, ['uint256'], [packId]) });
  const rc = await chain.waitForReceipt(hash, { timeoutMs: 120_000 });
  if (Number(rc.status) !== 1) throw new Error('The refund reverted.');
}

export async function balanceOf(chain: ChainClient, who: string): Promise<bigint> { return (chain as TxChain).getBalance(who); }
