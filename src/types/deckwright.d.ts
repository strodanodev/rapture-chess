// Deckwright ships its wallet layer as plain JS (web/lib); these are the parts Rapture Chess uses.
declare module 'deckwright/web/lib/wallet.js' {
  export interface WalletSnapshot { address: string | null; chainId: number | null; connected: boolean; onCorrectChain: boolean }
  export interface Wallet {
    readonly address: string | null;
    readonly connected: boolean;
    snapshot(): WalletSnapshot;
    subscribe(fn: (s: WalletSnapshot, kind: string) => void): () => void;
    connect(): Promise<string>;
    restore(opts?: { force?: boolean }): Promise<string | null>;
    disconnect(): Promise<void>;
    ensureChain(): Promise<boolean>;
    personalSign(message: string | Uint8Array): Promise<string>;
  }
  export class WalletError extends Error { code: string }
  export const LITEFORGE: { chainId: number; name: string; explorer: string; faucet: string };
  export function createWallet(opts?: Record<string, unknown>): Wallet;
}
declare module 'deckwright/web/lib/holdings.js' {
  export interface Holdings {
    read(wallet: string, opts?: { signal?: AbortSignal; deep?: boolean }): Promise<{ tokens: string[]; count: number }>;
    identify(tokenIds: string[], opts?: { signal?: AbortSignal }): Promise<Map<string, { tokenId: string } | null>>;
  }
  export function createHoldings(opts: { collection: Record<string, unknown> }): Holdings;
}
declare module 'deckwright/src/core/rng.ts' {
  export function seededRandom(seedHex: string): () => number;
  export function shuffle<T>(items: T[], rnd: () => number): T[];
}
