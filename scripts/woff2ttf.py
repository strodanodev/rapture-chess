# WOFF 1.0 -> TTF/OTF with the standard library only (each table is zlib-compressed in WOFF 1.0).
#   python scripts/woff2ttf.py in.woff out.ttf
# Blender's text objects need an sfnt font; the game ships Cinzel as WOFF through @fontsource (OFL), so the title
# model is built from the same font file.
import struct, sys, zlib

src, dst = sys.argv[1], sys.argv[2]
b = open(src, "rb").read()
sig, flavor, _length, num = struct.unpack(">4sIIH", b[:14])
assert sig == b"wOFF", "not a WOFF 1.0 file"
tables = []
for i in range(num):
    tag, off, clen, olen, csum = struct.unpack(">4sIIII", b[44 + i * 20:64 + i * 20])
    data = b[off:off + clen]
    tables.append((tag, zlib.decompress(data) if clen < olen else data, csum))
tables.sort(key=lambda t: t[0])
es = max(p for p in range(16) if 2 ** p <= num)
head = struct.pack(">IHHHH", flavor, num, 16 * 2 ** es, es, num * 16 - 16 * 2 ** es)
offset = 12 + 16 * num
dirs, body = b"", b""
for tag, data, csum in tables:
    dirs += struct.pack(">4sIII", tag, csum, offset + len(body), len(data))
    body += data + b"\0" * (-len(data) % 4)
open(dst, "wb").write(head + dirs + body)
print("wrote", dst, len(head + dirs + body), "bytes,", num, "tables")
