# Wagers and match resolution

How a zkLTC wager on a Rapture Chess match is held, played and paid, today and once LitNode settles it.

## The pieces

| Piece | Where | Role |
|---|---|---|
| `ChessWager.sol` | `contracts/` | Escrow on Liteforge (chain 4441). `createMatch` / `joinMatch` hold the two stakes; `settle` pays out on the `resolver`'s EIP-712 signature; `cancel` and `timeoutClaim` make sure funds never stay locked. |
| `src/web3/wager.ts` | client + relay | The one definition of `matchId = keccak256(seed)`, `seedCommit`, `logHash = keccak256(abi.encode(bytes32 seed, int32[] inputs))`, the EIP-712 typed data, ABI and calldata. |
| `relay/server.mts` | `pnpm relay` | Seats two wallets (challenge signed with `personal_sign`), orders the moves into the Deckwright-style log, runs the turn clock, concedes a player who stays away, and signs the settlement with `RESOLVER_PRIVATE_KEY`. With `RPC_URL` + `WAGER_ADDRESS` it only seats the wallets the escrow recorded. |
| `src/game/relay.ts` | client | `RelayMatch`: the board plays a relayed match exactly like the local one, applying only entries the relay echoes. |
| `src/wager/` | client | The wager panel: create, share the join link, join, settle. |
| `src/litnode/chessTitle.ts` | LitNode | The title adapter (`rapture-chess.v1`): `init`/`step`/`done`/`scores` over the same log. |

## Settlement path

**Today (relay-signed).** The relay operator's key is the escrow's `resolver`. When a game ends, the relay signs
`Settlement(bytes32 matchId, uint8 winner, bytes32 logHash)` under the domain
`{ name: "RaptureChessWager", version: "1", chainId: 4441, verifyingContract: <escrow> }` and sends it to both
players; either submits `settle(matchId, winner, logHash, sig)`. Anyone can audit a payout: fetch `GET /match/<id>`
from the relay, replay `entries` from `seed` with `createChessRules()`, recompute `logHash`, and compare the winner.
The trust assumption is the relay key; the fallback for a silent relay is `timeoutClaim` (50/50 after `settleTimeout`).

**Next (LitNode-settled).** LitNode places a match (seed from its beacon, a host plus three witnesses), the gauntlet
collects both players' ledger signatures, posts `/ledger`, and the node replays the log through the pinned ruleset
(`rapture-chess.v1`, built from `chessTitle.ts`) before `MatchBook.settle`. To pay the wager from that result the
owner points `resolver` at the LitNode settlement signer (or at a small contract that re-signs after
`MatchBook.settle` for the match id); the typed data and the clients do not change. The relay already keeps the
gauntlet hooks (`GAUNTLET_SECRET` HMAC seat tickets, the `{ k, inputs }` log), so a node can host it with a
`gauntlet.json` pointing at `pnpm relay`.

What is still missing for that:
- the title build and registration (`TitleRegistry.register(rulesetId, buildHash)`), and a node with the ruleset mounted;
- signed ledger submission from the relay (`/ledger`) and the cabinet shell for seat tickets, as in Deckwright's relay;
- a `wager` mode in the placement, so the match id the node assigns is also the escrow's match id (today the creator
  picks the seed; under LitNode the beacon does, so `createMatch` would follow placement).

LitNode integration is deferred for the whole Rapture stack, and the ERC-6699 registry mismatch between LitNode and
RaptureCards is a known, separately tracked item: neither is a finding of this work. Chess does not read champion
stats, so the mismatch does not affect its settlement; it only matters for ranked ladders keyed to card ownership.

## Running it locally

```bash
# relay with a throwaway resolver key and the escrow domain (signs settlements; no chain reads)
RESOLVER_PRIVATE_KEY=0x… WAGER_ADDRESS=0x… pnpm relay
# relay in dev mode (no wallet signatures, any name seats)
RELAY_DEV=1 pnpm relay
# contract tests, and a two-client relay smoke test to settlement
pnpm test:contracts
pnpm test:relay
# deploy the escrow (PRIVATE_KEY funded with zkLTC; writes deployments/liteforge.json)
RESOLVER=0x… PRIVATE_KEY=0x… npx hardhat run scripts/deploy-wager.cjs --network liteforge
```

The client reads `VITE_WAGER_ADDRESS` and `VITE_RELAY_URL` at build time; production also needs the relay's
`wss://` origin in `connect-src` of `vercel.json`.
