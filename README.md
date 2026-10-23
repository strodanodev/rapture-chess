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

## Run it

```bash
pnpm install
pnpm dev          # http://127.0.0.1:4174
pnpm build        # static site in dist/
pnpm lint         # type check
```

## Rebuild the 3D set (Blender CLI)

```bash
# the board and the six plinths -> public/models/set.glb, plus a check render in renders/set.png
blender -b --python scripts/build-set.py -- public/models/set.glb renders/set.png
# the champion avatars, Draco-compressed with the four clips the game plays
blender -b --python scripts/export-avatars.py -- <dir of slug.glb> public/models/avatars
```

## Layout

```
src/rules/chessRules.ts   Deckwright-style ruleset: init/step over a 32-bit action log (chess.js inside)
src/game/                 the local match (log, bot in a worker)
src/roster.ts             collection -> two armies (owned cards first, seeded order)
src/web3/wallet.ts        Deckwright wallet + holdings for the Rapture collection
src/scene/                three.js: stage (post-processing), board, pieces, VFX (three.quarks), assets
src/ui/hud.ts             DOM HUD: champion card, move list, fallen, controls
scripts/                  Blender build scripts
public/models             set.glb and the avatars; public/art the card paintings; public/data the snapshot
```

Rendering: pmndrs `postprocessing` (bloom, chromatic aberration, vignette, ACES, SMAA), `n8ao` ambient occlusion,
`three.quarks` particles, a Reflector floor and a PMREM studio environment.

## Content

Rapture characters, names, avatars and artwork are © LitVM Games, all rights reserved; the snapshot and art are
included so the game can run. The code is Apache-2.0.
