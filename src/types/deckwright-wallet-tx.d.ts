// The wager flow sends transactions through the Deckwright wallet; the base declaration (deckwright.d.ts) merges with this.
declare module 'deckwright/web/lib/wallet.js' {
  interface Wallet {
    /** eth_sendTransaction from the connected account; resolves the hash. value/gas: bigint, number or 0x string. */
    sendTransaction(tx: { to: string; data?: string; value?: bigint | number | string; gas?: bigint | number | string }): Promise<string>;
  }
}
