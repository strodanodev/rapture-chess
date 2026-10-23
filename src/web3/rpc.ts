/**
 * Liteforge reads with a fallback: the public RPC answers "Bandwidth limit exceeded" under load, so every read retries
 * once on the partner endpoint LitNode's own cabinet falls back to. Writes still go through the wallet.
 */
import { createChain, type ChainClient } from 'deckwright/web/lib/chain.js';

export const RPCS = [
  (import.meta.env as Record<string, string | undefined>).VITE_RPC_URL ?? 'https://liteforge.rpc.caldera.xyz/http',
  'https://liteforge.rpc.caldera.xyz/infra-partner-http',
];

export function createReadChain(rpcs: string[] = RPCS): ChainClient {
  const clients = [...new Set(rpcs)].map((u) => createChain(u, { retries: 1 }));
  const each = <K extends keyof ChainClient>(k: K) => async (...args: unknown[]) => {
    let last: unknown;
    for (const c of clients) {
      try { return await (c[k] as (...a: unknown[]) => Promise<unknown>)(...args); } catch (e) {
        last = e;
        // a revert is an answer, not an outage: do not ask the next endpoint
        if ((e as { data?: unknown }).data || /revert/i.test((e as Error).message)) throw e;
      }
    }
    throw last;
  };
  return { call: each('call'), waitForReceipt: each('waitForReceipt'), request: each('request'), getBalance: each('getBalance'), estimateGas: each('estimateGas') } as ChainClient;
}
