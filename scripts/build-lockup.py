# Rapture Chess: the title lockup. RAPTURE in bevelled gold (the top word of renders/logo.png, from render-logo.py)
# over the chrome CHESS logo, which arrives on a green screen (renders/chess-logo.jpg) and is keyed out here.
#   python scripts/build-lockup.py renders/chess-logo.jpg renders/logo.png public/brand/rapture-chess.2.webp
# The keyer: alpha from how much greener than red or blue a pixel is, measured against the screen colour; edge colour
# un-mixed from the screen (so the sparkles keep their white halos) and any green left over clamped away (despill).
# The page shows one image for the whole title (home menu and boot screen), so it scales as one piece at every size.
import sys
import numpy as np
from PIL import Image, ImageFilter

chess_src, logo_src, out = sys.argv[1], sys.argv[2], sys.argv[3]

# ---- key the CHESS logo off its green screen
c = np.asarray(Image.open(chess_src).convert("RGB")).astype(np.float32)
edge = np.concatenate([c[:40].reshape(-1, 3), c[-40:].reshape(-1, 3)])
key = np.median(edge, axis=0)                                   # the screen colour, about (6, 254, 3)
green = c[..., 1] - np.maximum(c[..., 0], c[..., 2])            # how much greener than the other channels
screen = key[1] - max(key[0], key[2])                           # the screen's own greenness, about 248
FULL, CLEAR = 12.0, screen - 14.0                               # at or below FULL: solid metal; at or above CLEAR: gone
a = np.clip((CLEAR - green) / (CLEAR - FULL), 0.0, 1.0)
a[a < 0.03] = 0.0
# un-mix the edge colour from the screen: C = a*F + (1-a)*K  =>  F = (C - (1-a)*K) / a
f = (c - (1.0 - a[..., None]) * key) / np.maximum(a[..., None], 1e-3)
f = np.clip(f, 0, 255)
f[..., 1] = np.minimum(f[..., 1], np.maximum(f[..., 0], f[..., 2]))   # despill: never greener than red or blue
# the JPEG's half-resolution colour bleeds green a pixel or two into the metal: within 3 px of the edge, hold green to
# the copper of the letters' own dark outline, and choke the edge by a pixel
solid = np.asarray(Image.fromarray((a > 0.99).astype(np.uint8) * 255).filter(ImageFilter.MinFilter(7))) > 0
rim = (a > 0) & ~solid
f[..., 1] = np.where(rim, np.minimum(f[..., 1], 0.8 * f[..., 0] + 0.2 * f[..., 2]), f[..., 1])
a = np.minimum(a, np.asarray(Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))) / 255.0)
# the sparkles' flares and halos are light, not metal: where the key leaves them see-through, make them warm white
lum = 0.2126 * f[..., 0] + 0.7152 * f[..., 1] + 0.0722 * f[..., 2]
soft = np.clip((0.9 - a) / 0.5, 0.0, 1.0)[..., None]
f = f * (1 - soft) + lum[..., None] * np.array([1.0, 0.95, 0.84]) * soft
chess = Image.fromarray(np.dstack([np.clip(f, 0, 255), a * 255]).round().astype(np.uint8), "RGBA")
chess = chess.crop(chess.getchannel("A").point(lambda v: 255 if v > 6 else 0).getbbox())

# ---- RAPTURE: the top word of the Blender title render
logo = Image.open(logo_src).convert("RGBA")
la = np.asarray(logo.getchannel("A"))
rows = np.where(la.max(1) > 8)[0]
gap = next(i for i in range(len(rows) - 1) if rows[i + 1] - rows[i] > 20)   # the blank band between the two words
rapture = logo.crop((0, 0, logo.width, rows[gap] + 4))
rapture = rapture.crop(rapture.getchannel("A").point(lambda v: 255 if v > 6 else 0).getbbox())

# ---- compose: CHESS under RAPTURE, its upper horns rising behind the word so the two read as one mark
W = 1280                                    # the lockup's width in pixels (the page shows it at up to ~560 css px)
CHESS_W = W                                 # the chrome mark spans the full width
RAPTURE_W = round(W * 0.80)                 # the gold word a little narrower, crowned by the horns
TUCK = 0.15                                 # how far CHESS rides up under RAPTURE, as a share of CHESS's height
chess = chess.resize((CHESS_W, round(chess.height * CHESS_W / chess.width)), Image.LANCZOS)
rapture = rapture.resize((RAPTURE_W, round(rapture.height * RAPTURE_W / rapture.width)), Image.LANCZOS)
top = rapture.height - round(chess.height * TUCK)
H = top + chess.height
canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
canvas.alpha_composite(chess, (0, top))
# a soft dark halo under RAPTURE, so the gold word separates from the chrome horns behind it
shadow = Image.new("RGBA", rapture.size, (6, 3, 2, 0))
shadow.putalpha(rapture.getchannel("A").filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(10)).point(lambda v: round(v * 0.75)))
rx = (W - RAPTURE_W) // 2
canvas.alpha_composite(shadow, (rx, 0))
canvas.alpha_composite(rapture, (rx, 0))
canvas = canvas.crop(canvas.getchannel("A").point(lambda v: 255 if v > 6 else 0).getbbox())

canvas.save(out, "WEBP", quality=84, alpha_quality=90, method=6)
print(f"{out} {canvas.width}x{canvas.height}  rapture {rapture.size}  chess {chess.size}  key {key.round()}")
