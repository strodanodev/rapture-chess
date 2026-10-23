# Rapture Chess

3D chess on LitVM, where the fifty champions of **Rapture ARC 1** take the board. Built with
[Deckwright](https://github.com/strodanodev/deckwright), three.js and Blender.

- **Alliance is White, Horde is Black.** Each piece type is held by one Kind: Gods on the royal seats, Titans in the
  rook towers, Kings as bishops, Demigods as knights, Mortals on the pawn line.
- **Your NFTs take the field first.** Connect a Liteforge wallet and the Rapture cards it holds are seated before the
  rest of the set (Deckwright's wallet and holdings layer).
- **Every champion is their avatar.** The pieces are the collection's rigged avatars, animated (idle, strike, hit,
  fall), standing on Blender-built plinths lit in their element.
- **Matches are replayable logs.** Moves are one 32-bit integer per log entry in Deckwright's shape
  (`{ k, inputs: [alliance, horde] }`), so a relay or a LitNode ruleset can replay the same game from the seed and
  the log. The finished log is printed to the console.

- **Two realms.** Alliance games play in Valhalla (stone hall, gold, aurora), Horde games in the Underworld (basalt
  crater, lava moat); both arenas are Blender-built and chosen on the title screen.
- **60 fps by design.** Quality presets (low to ultra) and an adaptive governor that steps the pixel ratio, ambient
  occlusion, mirror floor, shadows and anti-aliasing down whenever the frame rate dips under 58 fps.
- **A LitNode title, plug and play.** `pnpm title` bundles the rules into `rulesets/rapture-chess.v1.js` (conformant,
  hash-pinned); `gauntlets/rapture-chess.json` lets any LitNode host run the match server per placed match; the page
  seats through the arcade shell and both players sign the ledger, which the node replays and settles.
- **Wagers in zkLTC, resolved by LitNode.** `contracts/LitNodeWager.sol` holds stakes bound to player keys and pays out on
  the host node's signed delta (ed25519 verified on chain, host bonded on NodeStake, MatchBook finality when the match
  is on chain). No key of ours decides a match. See `src/litnode/README.md`.

## Run it

```bash
pnpm install
pnpm dev          # http://127.0.0.1:4174
pnpm build        # static site in dist/
pnpm lint         # type check
pnpm test         # hardhat escrow tests, canonical-JSON test, relay tests (dev and gauntlet modes)
pnpm title        # LitNode title bundle + conformance (needs ../LITNODE/litnode or LITNODE_DIR)
RELAY_DEV=1 pnpm relay   # a dev relay: open the game twice with ?relay=ws://127.0.0.1:7831&room=x&name=alice / bob
```

Client env (`.env`): `VITE_WAGER_ADDRESS` (deployed escrow), `VITE_RPC_URL` (optional).
Deploy the escrow with `PRIVATE_KEY=0x… npx hardhat run scripts/deploy-wager.cjs --network liteforge` (it reads LitNode's
NodeStake, MatchBook and PlayerProfile addresses from the LitNode checkout). Hosting the title on a node, claiming it on
TitleRegistry and the arcade launch are in `src/litnode/README.md`.

## Rebuild the 3D set (Blender CLI)

```bash
# the board and the six plinths -> public/models/set.glb, plus a check render in renders/set.png
blender -b --python scripts/build-set.py -- public/models/set.glb renders/set.png
# the champion avatars, Draco-compressed with the four clips the game plays
blender -b --python scripts/export-avatars.py -- <dir of slug.glb> public/models/avatars
# the two arenas -> public/models/valhalla.glb and underworld.glb, with check renders; textured with the CC0
# Poly Haven sets in scripts/textures (512 px copies of the 1k sets; README.txt there) and merged by material
blender -b --python scripts/build-arenas.py -- public/models renders
# the main-menu title in bevelled Cinzel -> public/models/title.glb (the TTFs come from the game's own WOFFs)
python scripts/woff2ttf.py node_modules/@fontsource/cinzel/files/cinzel-latin-900-normal.woff scripts/fonts/Cinzel-Black.ttf
python scripts/woff2ttf.py node_modules/@fontsource/cinzel/files/cinzel-latin-700-normal.woff scripts/fonts/Cinzel-Bold.ttf
blender -b --python scripts/build-logo.py -- public/models
```

Both scripts also run inside a live Blender through MCP (`sys.argv = ["", "--", out_dir, ...]`, then exec the file):
they empty the open file instead of loading factory settings, which would unload the MCP addon.

## Layout

```
src/rules/chessRules.ts   Deckwright-style ruleset: init/step over a 32-bit action log (chess.js inside)
src/game/                 the local match (log, bot in a worker)
src/roster.ts             collection -> two armies (owned cards first, seeded order)
src/web3/wallet.ts        Deckwright wallet + holdings for the Rapture collection
src/scene/                three.js: stage (post-processing, quality governor), realm, board, pieces, VFX (three.quarks), assets
src/game/relay.ts         RelayMatch: a placed LitNode match (arcade shell seat + ledger signature) or a dev room
src/wager/                the zkLTC wager panel; src/web3/wager.ts + canonical.ts the claim encoding
contracts/                LitNodeWager.sol (+ vendored Ed25519, mocks, hardhat tests)
relay/ gauntlets/         the gauntlet match server LitNode spawns per match, and its node config
src/litnode/ rulesets/    the title (defineTitle shape), its bundled hash-pinned ruleset, the hosting guide
src/ui/hud.ts             DOM HUD: champion card, move list, fallen, controls
scripts/                  Blender build scripts
public/models             set.glb and the avatars; public/art the card paintings; public/data the snapshot
```

Rendering: pmndrs `postprocessing` (bloom, chromatic aberration, vignette, ACES, SMAA), `n8ao` ambient occlusion,
`three.quarks` particles, a Reflector floor and a PMREM studio environment.

## Live on LitNode

The title is registered (`rapture-chess.v1`, build `cf604358…`), the escrow is deployed at
`0x743051a665471111c3c74EC9138B9fc516730e35`, and a dedicated bonded node hosts the gauntlet. `GO-LIVE.md` is the
operator runbook: node launcher, logon task, bond and announce, key rotation.

## Content

Rapture characters, names, avatars and artwork are © LitVM Games, all rights reserved; the snapshot and art are
included so the game can run. The code is Apache-2.0.
