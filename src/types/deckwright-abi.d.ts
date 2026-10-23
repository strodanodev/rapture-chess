// Deckwright's hand-rolled ABI and JSON-RPC helpers (web/lib), the parts the wager flow uses.
declare module 'deckwright/web/lib/abi.js' {
  export function isHex(s: unknown, bytes?: number): boolean;
  export function isAddress(s: unknown): boolean;
  export function bytesToHex(bytes: Uint8Array): string;
  export function hexToBytes(hex: string): Uint8Array;
  export const utf8ToHex: (text: string) => string;
  export const boolAt: (ws: string[], i: number) => boolean;
  export function toBigInt(v: bigint | number | string): bigint;
  export function toQuantity(v: bigint | number | string): string;
  export function fromQuantity(hex: string): bigint;
  export function encodeArgs(types: string[], values: unknown[]): string;
  export function encodeCall(selector: string, types?: string[], values?: unknown[]): string;
  export function words(data: string): string[];
  export const uintAt: (ws: string[], i: number) => bigint;
  export const addressAt: (ws: string[], i: number) => string;
  export function extractRevertData(err: unknown): string | null;
}
declare module 'deckwright/web/lib/chain.js' {
  export interface ChainClient {
    call(tx: { to: string; data: string; from?: string; blockTag?: string }, opts?: { signal?: AbortSignal }): Promise<string>;
    waitForReceipt(hash: string, opts?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<{ status: string | number; blockNumber?: string; logs?: unknown[] } & Record<string, unknown>>;
    request(method: string, params?: unknown[], opts?: { signal?: AbortSignal }): Promise<unknown>;
    getBalance(address: string): Promise<bigint>;
    estimateGas(tx: { from?: string; to: string; data?: string; value?: bigint }): Promise<bigint>;
  }
  export function createChain(rpc: string, opts?: Record<string, unknown>): ChainClient;
}
