# Assets

The code in this repository is open source; the art is not included.

The Rapture characters, their card art and 3D avatars, the arena and board models, the brand marks and the renders are
(c) LitVM Games, all rights reserved. They live in LitVM Games' private repository and ship only with the deployed game,
so these paths are missing from a fresh clone:

| Path | What it holds | How to get it |
|---|---|---|
| `public/art/` | Rapture card art | Public at `https://forge.litvm.games/assets/rapture/art/` |
| `public/models/avatars/` | Rapture 3D avatars (rigged: idle, attack, hit, death) | Export from the Rapture avatar GLBs with `scripts/export-avatars.py` (Blender CLI) |
| `public/models/` | The Valhalla and Underworld arenas and the board | Build with `scripts/build-set.py` and `scripts/build-arenas.py` (Blender CLI) |
| `public/brand/`, `renders/` | Logos and renders | Ask LitVM Games |

The textures under `scripts/textures/` are CC0 (Poly Haven) and are included.

To use Rapture characters in your own project, ask LitVM Games for permission.
