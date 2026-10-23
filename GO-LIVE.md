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
