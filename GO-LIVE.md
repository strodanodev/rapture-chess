# Rapture Chess on LitNode: operator runbook

Current state (2026-10-24) and the operations around it. Everything here is live unless marked otherwise.

## What is live

| Piece | Where | State |
|---|---|---|
| Title `rapture-chess.v1` | TitleRegistry `0x4A0d…4489`, Liteforge 4441 | registered to `0x729a7da21df1252e724c67be415f36f2e1a9f626`, build `cf604358…` active (tx `0xf37bd7…`) |
| Ruleset | `rulesets/rapture-chess.v1.js` (+ `.json`) | conformant, hash-pinned; rebuild with `pnpm title` only when the rules change, then `publish:title -- set-build` |
| Escrow `LitNodeWager` | `0x743051a665471111c3c74EC9138B9fc516730e35` | owner `0x729a…f626`, unstake delay 4000 s, fee 0; the site carries it (`.env`) |
| Site | https://rapture-chess.vercel.app | Vercel project `rapture-chess`, NPC team; redeploy: `pnpm build` then the `vercel deploy` line in DEPLOY.local.md |
| Chess node `a0b440f4…` | this laptop, port 7811, gateway 8488, quick tunnel | 0.12.1 source checkout (`LITNODE\litnode`), bonded 1 tLITVM by `0x729a…f626`, announcer `0xf41c…d2d2f` delegated and funded, `/titles` shows `published: true` |
| Logon task `litnode-chess` | Task Scheduler, current user | runs `C:\litvm\rapture-chess\start-chess-node.ps1` at logon |

## The two nodes on this laptop, and why chess stays on the dedicated one

| | Control Plane node `50bb1da9…` | Chess node `a0b440f4…` |
|---|---|---|
| Port / gateway | 7801 / 8478 (upstream 8477) | 7811 / 8488 |
| Version | 0.12.1, protocol 4 (auto-updated) | 0.12.1, protocol 4, updates off |
| Bond | `0x8697…87b5` (StudioMinter admin) | `0x729a…f626` (the title's publisher) |
| Chess ruleset | held (fetched by hash, since the title is registered) | loaded from `RULESETS` |
| Chess gauntlet | none (`GAUNTLETS` lists Agent Fighter and Pickle Brawl) | `gauntlets/rapture-chess.json` |
| Relay tunnel | **down**: nothing listens on 8477, so the gateway answers 502 at `/` and no `wsAddr` is advertised | up |

The arcade lists a title only while a bonded host from the publisher's wallet serves it, and placements prefer hosts
that advertise a relay. Today only the chess node meets both, so it is the chess host. Folding chess into the Control
Plane node would need, in this order: the Agent Fighter relay back on 8477 (or `RELAY_PORT` unset) so its tunnel
advertises; `rapture-chess.v1=C:/Users/strodano/Documents/LitVM Games/CHESS/gauntlets/rapture-chess.json` appended to
the user `GAUNTLETS` variable and a Control Plane restart; and the title transferred to `0x8697…87b5` (or that node
re-bonded from `0x729a…f626`). Until then, two nodes.

Both nodes are bonded under different wallets, so they count as different operators for witnessing each other.

## Day to day

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\litvm\rapture-chess\start-chess-node.ps1 -Status   # stages, peers, bond, announcer
powershell -NoProfile -ExecutionPolicy Bypass -File C:\litvm\rapture-chess\start-chess-node.ps1 -Stop
powershell -NoProfile -ExecutionPolicy Bypass -File C:\litvm\rapture-chess\start-chess-node.ps1            # start (supervised)
curl.exe -s http://127.0.0.1:7811/titles
curl.exe -s http://127.0.0.1:8488/gateway
Get-Content C:\litvm\rapture-chess\litnode.log -Tail 40
```

The launcher clears `GAUNTLETS`, `GAUNTLET_GATEWAY_PORT`, `RELAY_PORT`, `RULESETS`, `SERVICES` and `COURTS` from the
inherited environment first: the 0.12 supervisor lets the process environment override `node.env`, and those user
variables belong to the Control Plane node. `host status` reports "service not installed" because it only looks for its
own task name; the `litnode-chess` logon task is what keeps the node up (`Unregister-ScheduledTask -TaskName litnode-chess`
removes it).

Gas: the announcer `0xf41c…d2d2f` pays for commits and settlements (about 445k gas per hosted ranked match, 77k per
witnessed one). The log prints `gas-low` when it runs short; top it up with `npm run host -- announce --fund 0.02`
(OPERATOR_KEY in the shell) or a plain transfer to that address.

Updates: `LITNODE_NO_UPDATE=1` is set in `C:\litvm\rapture-chess\node.env` because the node's self-update replaces the
git checkout with the portable release, which drops `tools/`. Update by hand:

```powershell
cd "C:\Users\strodano\Documents\LitVM Games\LITNODE\litnode"
git pull && npm install
powershell -NoProfile -ExecutionPolicy Bypass -File C:\litvm\rapture-chess\start-chess-node.ps1 -Stop
powershell -NoProfile -ExecutionPolicy Bypass -File C:\litvm\rapture-chess\start-chess-node.ps1
```

Node files: `C:\litvm\rapture-chess\node.env` (config), `C:\litvm\rapture-chess\litnode.log`,
`LITNODE\litnode\data\rapture-chess\` (identity, ledgers, deltas). Back up `identity.json` there: it is the node key the
bond is behind.

## How a match runs

1. A player queues for Rapture Chess in the arcade; the mesh places the match on a host.
2. The host node spawns `relay/server.mts` for that match (`node_modules/tsx/dist/cli.mjs` from the CHESS checkout, so keep
   `pnpm install` current there), mints seat tickets and proxies `wss://<wsAddr>/<room>`.
3. The arcade opens https://rapture-chess.vercel.app/ with `?match&ws&room&player&build`; the page claims its seat through
   the shell, plays, and at the end both players sign the ledger (`cabinet:sign`).
4. The relay posts `/ledger`; the node replays the log in its sandbox and settles. Ranked placed matches also go to
   MatchBook (commit, settle, witness attests, finalize). Casual ones settle on the node only.
5. A stake pays out from the node's signed delta: the wager panel fetches `GET /delta/<matchId>` from the host and submits
   `claim` to the escrow (about 3.3M gas).

## Key rotation (the publisher key was pasted into a chat on 2026-10-23 and 2026-10-24: treat it as exposed)

`0x729a…f626` holds the title, the chess node's bond and the escrow's owner role. Move all three to a fresh wallet in
one sitting so the title owner and the bond operator keep matching. Fund the new wallet with a little zkLTC first; type
keys, never paste them.

```powershell
cd "C:\Users\strodano\Documents\LitVM Games\LITNODE\litnode"
# 1. title
$env:PUBLISHER_KEY = "0x<old key>"
npm run publish:title -- transfer "C:\Users\strodano\Documents\LitVM Games\CHESS\rulesets\rapture-chess.v1.js" 0x<new wallet>
Remove-Item Env:PUBLISHER_KEY
# 2. bond (NodeStake.transferOperator; the node keeps running, its announcer is unaffected)
$env:DEPLOYER_KEY = "0x<old key>"
node tools/transfer-operator.mjs a0b440f4c88fcda3dd8b5783cf23f06d16d408b162de24bf82aa5fad298e1175 0x<new wallet>
Remove-Item Env:DEPLOYER_KEY
# 3. escrow owner (fees and settings only; stakes and claims never depend on it)
cd "C:\Users\strodano\Documents\LitVM Games\CHESS"
$env:PRIVATE_KEY = "0x<old key>"; $env:NEW_OWNER = "0x<new wallet>"
npx hardhat run scripts/transfer-wager-owner.cjs --network liteforge
Remove-Item Env:PRIVATE_KEY, Env:NEW_OWNER
```

Then sweep what remains in the old wallet and confirm with `npm run publish:title -- status …` and the node's `/titles`
(`publisherHosts: 1, published: true` under the new owner). The escrow address and the site do not change.

## Not yet exercised

- A match through the live arcade end to end (two browsers, two player keys): seat ticket, gauntlet, ledger
  signatures, node settlement. The same path was tested against a local node and a dev relay only.
- A stake and claim on testnet against a real delta.
- A ranked placement for chess (needs four bonded operators carrying the title; `/titles` shows three bonded hosts).

## History

- 2026-10-23: title registered; escrow deployed and wired into the site; the Control Plane node (then 0.11.29) could not
  load the title because its app hard-codes `RULESETS`.
- 2026-10-24: dedicated node initialised, bonded, announced, published; self-update clobbered the checkout once
  (reset to `origin/master`, updates off); logon task registered.
