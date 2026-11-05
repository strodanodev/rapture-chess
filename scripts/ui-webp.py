# The UI renders (scripts/render-ui.py) as WebP for the page: lossy colour, lossless-quality alpha edges.
#   python scripts/ui-webp.py renders/ui public/ui
import os, sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
for f in sorted(os.listdir(src)):
    if not f.endswith(".png"):
        continue
    im = Image.open(os.path.join(src, f)).convert("RGBA")
    out = os.path.join(dst, f[:-4] + ".webp")
    im.save(out, "WEBP", quality=86, alpha_quality=95, method=6)
    print(f"{out} {im.size[0]}x{im.size[1]} {os.path.getsize(out) // 1024} KB")
