"""PWA icons from the caduceus emblem (public/brand/emblem.webp) -> public/brand/icon-*.png.

    python scripts/build-icons.py

icon-192 / icon-512: the emblem on the obsidian ground (Android home screen, Chrome install dialog).
icon-maskable-512:   the emblem inside the 80% safe zone, so adaptive-icon masks never clip it.
apple-touch-icon:    180 px, opaque (iOS squares the corners itself and paints transparency black).
"""
from pathlib import Path
from PIL import Image

BRAND = Path(__file__).resolve().parent.parent / 'public' / 'brand'
BG = (11, 9, 16, 255)  # --bg-1


def icon(size: int, fill: float, name: str) -> None:
    emblem = Image.open(BRAND / 'emblem.webp').convert('RGBA')
    scale = size * fill / max(emblem.size)
    emblem = emblem.resize((round(emblem.width * scale), round(emblem.height * scale)), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), BG)
    out.alpha_composite(emblem, ((size - emblem.width) // 2, (size - emblem.height) // 2))
    out.save(BRAND / name, optimize=True)
    print(name, out.size)


icon(192, 0.84, 'icon-192.png')
icon(512, 0.84, 'icon-512.png')
icon(512, 0.64, 'icon-maskable-512.png')
icon(180, 0.78, 'apple-touch-icon.png')
