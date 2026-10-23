# Rapture Chess on LitNode

Rapture Chess is a **replayable LitNode title**: one import-free ruleset the mesh pins by hash, a gauntlet match
server the host node runs per match, a client the arcade launches, and a wager escrow that pays out from the node's
own settled result. Nothing here needs a key of ours to decide a match.

Verified against the public LitNode checkout at `../LITNODE/litnode` (v0.12.0, protocol 4).

## The pieces

| LitNode step | What LitNode does | What this repo provides |
|---|---|---|
| Title | `defineTitle` shape, conformance suite, `buildHash = H('ruleset', bytes)` | `src/litnode/chessTitle.ts` → `pnpm title` → `rulesets/rapture-chess.v1.js` + `.json` (conformant) |
| Queue and placement | the cabinet signs `queue`; nodes pair players and place the match with a beacon seed | nothing: standard |
| Gauntlet | the host node spawns the title's match server per match, mints HMAC seat tickets, proxies `wss://<wsAddr>/<room>` | `relay/server.mts` + `gauntlets/rapture-chess.json` |
| Play | the client seats through the arcade shell (`cabinet:sign-seat`) and records the log | `src/game/relay.ts` `RelayMatch.placed()`; the page reads `?match&ws&room&player&build`; v2 logs carry the time control and clock stamps |
| Ledger | both players sign `{ matchId, ticks, head, buildHash }` (`cabinet:sign`); the gauntlet POSTs `/ledger` | the relay asks for both signatures and posts them (`players`); if a player left or will not sign, it posts under its own key (`relay`, `RELAY_KEYS`), then, casual only, unsigned (`host`) |
| Settlement | the node replays the log in its sandbox, signs the delta (`hostSig`), witnesses co-sign; ranked placed matches go to MatchBook | nothing: standard |
| Wager | nothing (LitNode has no stakes or payouts) | `contracts/LitNodeWager.sol` (v2): stakes bound to player keys, paid out on the node's signed delta (ed25519 verified on chain): both players' signatures, or the winner's alone on a placed match the publisher's own host settled; MatchBook finality when the match is on chain |

## Build and check the title

```bash
pnpm title       # esbuild → titles/rapture-chess.v1.mjs, then LitNode's tools/bundle-title.mjs → rulesets/ (runs the conformance suite)
```

The title is `rapture-chess.v2` (draw offers, the clock in the log, FIDE 6.9 timeouts); the v1 artifact stays pinned in
`rulesets/` for the matches still served under it. `rulesets/rapture-chess.v2.json` carries the `buildHash`. Register the exact `rulesets/rapture-chess.v1.js` the node loads
(CRLF would change the hash; the file is written with LF).

## Claim the title (publisher wallet)

From the LitNode checkout, with the publisher wallet's key in the shell only:

```bash
cd ../LITNODE/litnode
export PUBLISHER_KEY=0x...
npm run publish:title -- register "../../CHESS/rulesets/rapture-chess.v1.js"
npm run publish:title -- status   "../../CHESS/rulesets/rapture-chess.v1.js"
unset PUBLISHER_KEY
```

`register` claims `rapture-chess.v1` as an ERC-721 on TitleRegistry (`0x4A0d…4489` on Liteforge 4441) and activates the build.
A retune is `set-build` (active 60 s after mining). The arcade lists the title only while a bonded host node from the
same wallet serves it.

## Host it on a node

In the node's `node.env` (or as user environment variables for the LitNode Control Plane, which rewrites `node.env`):

```
RULESETS=C:/Users/strodano/Documents/LitVM Games/CHESS/rulesets/rapture-chess.v1.js
GAUNTLETS=rapture-chess.v1=C:/Users/strodano/Documents/LitVM Games/CHESS/gauntlets/rapture-chess.json
GAUNTLET_GATEWAY_PORT=8478
```

The gauntlet config's `cwd` must be this checkout with `pnpm install` done; the node runs
`node node_modules/tsx/dist/cli.mjs relay/server.mts` per match with `GAUNTLET_*` set. The node must have a public
`https://` address (its tunnel fronts the gateway as `wsAddr`). Bonding and placement are the operator's job
(`npm run host -- init/bond`, `docs/HOST-A-NODE.md`). Ranked placements need four operators carrying the title; until
then matches settle as casual (unplaced or `commitSkipped`), which the escrow still honours through the host's signature.

## Play from the arcade

The arcade launches `display.url` (https://rapture-chess.vercel.app/) in an iframe with `?ws&room&player&match&build`.
The page claims the seat (`GET <ws>/<room>/ticket?player=` → challenge → `cabinet:sign-seat` → ticket), joins the
gauntlet with `hello { ticket }`, plays, and at the end answers the relay's `sign` request with `cabinet:sign` over
the entries it recorded. The relay posts the ledger and broadcasts the node's delta.

Production CSP allows `frame-ancestors` for `arcade.litvm.games`, `*.litvm.games` and quick-tunnel hosts, and
`connect-src https: wss:` for the node and its relay.

## Wagers

`LitNodeWager.sol` holds zkLTC stakes bound to player keys. When a match between two staked keys settles, anyone
submits the node's delta (the canonical JSON the node signed) and `hostSig`; the contract verifies the ed25519
signature of the host node, checks the host is bonded on NodeStake, requires both players' signatures on the ledger
(`attestation: "players"`), and, if MatchBook knows the match, that it is `Final` with the same `resultHash`. The
winner takes the pot; a draw refunds. See `contracts/` and the wager panel in `src/wager/`.

What LitNode does not provide, by design: an escrow or payout of any kind (`docs/HOST-YOUR-TITLE.md`, Economics), so
the escrow is ours, resolved by LitNode's own settlement record.

## Known constraints

- Ranked needs four bonded operators under different wallets; the testnet mesh may not carry the title yet.
- ERC-6699 champions are not hydrated: the title plays with external agents, so the registry mismatch between
  LitNode's registry and the one RaptureCards mirrors into does not affect chess (the armies are cosmetic, drawn
  from the seed).
- A player's key must be bound to their wallet on PlayerProfile for the escrow to refuse stakes on someone else's key;
  without a profile the escrow accepts the binding on first use.
