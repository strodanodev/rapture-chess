# Rapture Chess on LitNode: the three key-holder steps

Everything below is already built, tested and deployed except what needs your keys. Run these in PowerShell on this
machine. Nothing writes a key to disk; set each one in the shell for the step that needs it and remove it after.

Paths used throughout:

```
CHESS   = C:\Users\strodano\Documents\LitVM Games\CHESS
LITNODE = C:\Users\strodano\Documents\LitVM Games\LITNODE\litnode   (public checkout, v0.12.0, npm install done)
```

The title bundle is `CHESS\rulesets\rapture-chess.v1.js`, build hash
`cf604358b9bf6e7faca935b158946f30f2404ec57fc4ffc712cf352bff54b660`. Rebuild it only if the rules change (`pnpm title`),
and then re-register the new hash with `set-build`.

## 1. Register the title on TitleRegistry (publisher wallet)

Use the wallet that will also bond your host node: the arcade lists a title only while a bonded host from the
publisher's wallet serves it. The wallet needs a little zkLTC on Liteforge (chain 4441) for gas.

```powershell
cd "C:\Users\strodano\Documents\LitVM Games\LITNODE\litnode"
$env:PUBLISHER_KEY = "0x<publisher private key>"
npm run publish:title -- status   "C:\Users\strodano\Documents\LitVM Games\CHESS\rulesets\rapture-chess.v1.js"
npm run publish:title -- register "C:\Users\strodano\Documents\LitVM Games\CHESS\rulesets\rapture-chess.v1.js"
npm run publish:title -- status   "C:\Users\strodano\Documents\LitVM Games\CHESS\rulesets\rapture-chess.v1.js"
Remove-Item Env:PUBLISHER_KEY
```

Expected: `status` first shows no publisher; `register` mines a transaction (the script polls up to 60 s for the
receipt); the final `status` shows your address as publisher and the build `cf604358…` as active.
`rapture-chess.v1` is first come, first served: if `register` says it is already held by another address, stop and
tell me.

Later retunes: `npm run publish:title -- set-build <same file>` (active 60 s after mining).

## 2. Deploy the escrow (any funded deployer wallet; it becomes the escrow owner)

```powershell
cd "C:\Users\strodano\Documents\LitVM Games\CHESS"
$env:PRIVATE_KEY = "0x<deployer private key>"
npx hardhat run scripts/deploy-wager.cjs --network liteforge
Remove-Item Env:PRIVATE_KEY
```

The script reads LitNode's NodeStake, MatchBook and PlayerProfile addresses from `LITNODE\contracts\deployed.testnet.json`
and writes `deployments\liteforge.json` under `litNodeWager`. Optional variables before the run:
`$env:OWNER = "0x…"` (fee and settings owner; default the deployer), `$env:UNSTAKE_DELAY = "4000"` (seconds; must stay
above MatchBook's total window of 3300 s).

Then put the address into the site and redeploy it:

```powershell
cd "C:\Users\strodano\Documents\LitVM Games\CHESS"
Set-Content -Encoding ascii .env "VITE_WAGER_ADDRESS=0x<escrow address from deployments\liteforge.json>"
pnpm build
vercel deploy --prod --yes --scope npc-31bbd654 --global-config "C:/Users/strodano/AppData/Local/vercel-npc"
```

Expected: https://rapture-chess.vercel.app shows the stake panel instead of "No escrow is configured".

## 3. Host the title on your Control Plane node

The Control Plane rewrites `node.env` on every start, so these go in as user environment variables, then quit the
Control Plane from the tray and reopen it. First see what is already set, because `GAUNTLETS` is a comma-separated
list and must keep any title already there (Pickle Brawl, for instance):

```powershell
Get-ChildItem Env: | Where-Object { $_.Name -in 'RULESETS','GAUNTLETS','GAUNTLET_GATEWAY_PORT','RELAY_PORT','SERVICES','COURTS' }
```

If `GAUNTLETS` is empty:

```powershell
setx RULESETS "C:/Users/strodano/Documents/LitVM Games/CHESS/rulesets/rapture-chess.v1.js"
setx GAUNTLETS "rapture-chess.v1=C:/Users/strodano/Documents/LitVM Games/CHESS/gauntlets/rapture-chess.json"
setx GAUNTLET_GATEWAY_PORT 8478
```

If `GAUNTLETS` or `RULESETS` already hold other titles, append with a comma instead, for example:

```powershell
setx RULESETS "<existing value>,C:/Users/strodano/Documents/LitVM Games/CHESS/rulesets/rapture-chess.v1.js"
setx GAUNTLETS "<existing value>,rapture-chess.v1=C:/Users/strodano/Documents/LitVM Games/CHESS/gauntlets/rapture-chess.json"
```

Keep `RELAY_PORT=8477` if it is set (the gateway fronts it as upstream). Then quit and reopen the Control Plane, and check:

```powershell
curl.exe -s http://127.0.0.1:7801/titles
curl.exe -s http://127.0.0.1:7801/health
```

Expected: `/titles` lists `rapture-chess.v1` with your address as `publisher` and `published: true` once the node is
bonded; `/health` shows `rulesets: { "rapture-chess.v1": "cf604358…" }`. The node's log prints
`ruleset rapture-chess.v1 @ cf604358b9bf loaded` and `gauntlet gateway on :8478 … rapture-chess.v1`.
If the node is on another port, use that port in the two checks.

The gauntlet config points at `CHESS` as its working directory; keep `pnpm install` current there, because the node
runs `node node_modules/tsx/dist/cli.mjs relay/server.mts` from it for every match.

## What happens next

- A player opens the arcade, queues for Rapture Chess, and the mesh places the match on your node. The node spawns the
  relay for that match, the page opens from `display.url` inside the arcade, seats through the shell, and both
  players sign the ledger at the end. The node replays the log and settles it.
- Ranked (on-chain) placements need four bonded operators under different wallets carrying the title. Until then
  matches settle as casual, which the escrow still honours through the host node's signature.
- A player stakes zkLTC against their arcade player key in the game's wager panel. After a match between two staked
  keys settles, the panel fetches the node's delta and submits the claim; the winner receives the pot.

## Step 3, revised (2026-10-23): the Control Plane node cannot load the title

Verified in the Control Plane app's code: `writeNodeEnvironment` hard-codes
`RULESETS=./rulesets/agent-fighter.v1.js,./rulesets/pickle-brawl.v1.js` into `node.env` on every start, and
`start-node.cmd` sets every `node.env` line over the inherited environment, so a user `RULESETS` variable is ignored
there. (`GAUNTLETS` passes through only because node.env has no such line.) That node is also on the 0.11 line
(protocol 3), bonded by `0x8697…87b5`, not by the title's publisher `0x729a…f626`.

The plug-and-play path is a dedicated node from the public 0.12 checkout, bonded from the publisher wallet:

```powershell
cd "C:\Users\strodano\Documents\LitVM Games\LITNODE\litnode"
npm run host -- init --operator rapture-chess --roles mesh,host,witness,settler --port 7811 --region ap-southeast --tunnel quick --rulesets "C:/Users/strodano/Documents/LitVM Games/CHESS/rulesets/rapture-chess.v1.js" --home "C:/litvm/rapture-chess"
Add-Content "C:/litvm/rapture-chess/node.env" "GAUNTLETS=rapture-chess.v1=C:/Users/strodano/Documents/LitVM Games/CHESS/gauntlets/rapture-chess.json`nGAUNTLET_GATEWAY_PORT=8488"
```

Caveat: the 0.12 supervisor lets the process environment win over node.env for known keys, and your user environment
carries `GAUNTLETS`, `GAUNTLET_GATEWAY_PORT=8478` and `RELAY_PORT=8477` for the Control Plane node. Start the chess
node from a shell that clears them, so it keeps its own values and does not fight over port 8478:

```powershell
Remove-Item Env:GAUNTLETS, Env:GAUNTLET_GATEWAY_PORT, Env:RELAY_PORT, Env:RULESETS -ErrorAction SilentlyContinue
$env:LITNODE_HOME = "C:/litvm/rapture-chess"
npm run host -- doctor
npm run host -- start --detach
curl.exe -s http://127.0.0.1:7811/titles
```

Then bond and publish it from the publisher wallet (1 tLITVM on testnet, faucet in the cabinet), key in the shell only:

```powershell
$env:OPERATOR_KEY = "0x<publisher private key>"
npm run host -- bond
npm run host -- announce --fund 0.02
npm run host -- publish
Remove-Item Env:OPERATOR_KEY
npm run host -- verify
```

For start-at-logon, `install-service` would inherit the clashing user variables; use a small launcher script that
clears them first (as above) and register that with schtasks instead. Not yet done.

## Dedicated node: running (2026-10-24)

- Home `C:\litvm\rapture-chess` (node.env, litnode.log); code `LITNODE\litnode` (0.12.0, protocol 4); data in `LITNODE\litnode\data\rapture-chess`.
- nodeId `a0b440f4c88fcda3dd8b5783cf23f06d16d408b162de24bf82aa5fad298e1175`, announcer `0xf41c9b338b8918a93cb22ef3957b28d4a4d42d2f`.
- Port 7811, gauntlet gateway 8488 (chess only), quick tunnel advertised as wsAddr. `/titles` lists rapture-chess.v1 with owner 0x729a…f626.
- Launcher: `C:\litvm\rapture-chess\start-chess-node.ps1` (`-Stop`, `-Status`); it clears the Control Plane's GAUNTLETS/ports/SERVICES
  variables before starting. For start at logon register that script with schtasks (command in the script header).

Bond and publish it from the publisher wallet (1 tLITVM on testnet; the key stays in the shell):

```powershell
cd "C:\Users\strodano\Documents\LitVM Games\LITNODE\litnode"
Remove-Item Env:GAUNTLETS, Env:GAUNTLET_GATEWAY_PORT, Env:RELAY_PORT, Env:RULESETS, Env:SERVICES, Env:COURTS -ErrorAction SilentlyContinue
$env:LITNODE_HOME = "C:/litvm/rapture-chess"
$env:OPERATOR_KEY = "0x<publisher private key>"
npm run host -- bond
npm run host -- announce --fund 0.02
npm run host -- publish
Remove-Item Env:OPERATOR_KEY
npm run host -- verify
```

## Bonded (2026-10-24); announce still to do

- `bond` landed: 1 tLITVM behind node a0b440f4… for operator 0x729a…f626, active (tx 0xf63af3a2…).
- The node's self-update replaced the git checkout with the 0.12.1 *portable* release, which ships no `tools/set-announcer.mjs`,
  so `announce` failed. The checkout was reset to `origin/master` (0.12.1 source, all tools) and `LITNODE_NO_UPDATE=1`
  was added to `C:\litvm\rapture-chess\node.env` so the hourly update check stays off. Update by `git pull` + restart instead.

Re-run the announce (delegates and funds the node's gas key `0xf41c…d2d2f`; the key stays in the shell):

```powershell
cd "C:\Users\strodano\Documents\LitVM Games\LITNODE\litnode"
Remove-Item Env:GAUNTLETS, Env:GAUNTLET_GATEWAY_PORT, Env:RELAY_PORT, Env:RULESETS, Env:SERVICES, Env:COURTS -ErrorAction SilentlyContinue
$env:LITNODE_HOME = "C:/litvm/rapture-chess"
$env:OPERATOR_KEY = "0x<publisher private key>"
npm run host -- announce --fund 0.02
Remove-Item Env:OPERATOR_KEY
npm run host -- publish
npm run host -- verify
```

## Live (2026-10-24)

- Announcer `0xf41c…d2d2f` delegated (tx 0xffaf740a…) and funded 0.02 zkLTC (tx 0x2749dbee…).
- `/titles` on the chess node: `rapture-chess.v1` owner 0x729a…f626, `publisherHosts: 1`, `bondedHosts: 4`, **`published: true`**.
  The arcade lists the title while this node is up and bonded. Keep the node running (launcher + schtasks for logon).
- Top up the announcer when the node logs `gas-low` (each hosted ranked match costs it ~445k gas; witnessing ~77k).
- Logon task `litnode-chess` (Task Scheduler, current user, at logon) runs `C:\litvm\rapture-chess\start-chess-node.ps1`,
  which clears the Control Plane's variables and starts the supervised node. Remove with
  `Unregister-ScheduledTask -TaskName litnode-chess`. `host status` still says "service not installed" because it only
  looks for its own task name; the logon task is what keeps the node up.

## Key rotation (the publisher key was pasted into a chat on 2026-10-23 and 2026-10-24: treat it as exposed)

The wallet `0x729a…f626` holds three things: the title (TitleRegistry ERC-721), the node's bond (NodeStake operator) and
the escrow's owner role. Move all three to a fresh wallet in one sitting, so the title owner and the bond operator stay the
same address (the arcade lists the title only while they match). Fund the new wallet with a little zkLTC first; type keys,
never paste them.

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

Then sweep whatever zkLTC and tLITVM remain in the old wallet, and check `npm run publish:title -- status …` and the node's
`/titles` (`publisherHosts: 1, published: true` under the new owner). The escrow address and the site do not change.
