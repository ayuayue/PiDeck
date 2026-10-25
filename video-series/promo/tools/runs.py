import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
W, H = im.size
def hexc(p): return "#%02x%02x%02x" % p
def row_runs(y, tol=3, minlen=2):
    px = im.load(); out = []; s = 0; cur = px[0, y]
    for x in range(1, W):
        c = px[x, y]
        if max(abs(c[i]-cur[i]) for i in range(3)) > tol:
            if x - s >= minlen: out.append((s, x-1, hexc(cur)))
            s = x; cur = c
    out.append((s, W-1, hexc(cur))); return out
def col_runs(x, tol=3, minlen=2):
    px = im.load(); out = []; s = 0; cur = px[x, 0]
    for y in range(1, H):
        c = px[x, y]
        if max(abs(c[i]-cur[i]) for i in range(3)) > tol:
            if y - s >= minlen: out.append((s, y-1, hexc(cur)))
            s = y; cur = c
    out.append((s, H-1, hexc(cur))); return out
mode = sys.argv[2]; v = int(sys.argv[3])
r = row_runs(v) if mode == "row" else col_runs(v)
print(mode, v, "runs:", len(r))
for a, b, c in r: print("  %4d..%4d  %s" % (a, b, c))
