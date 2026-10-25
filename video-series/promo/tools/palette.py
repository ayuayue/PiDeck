import sys
from collections import Counter
from PIL import Image
p = sys.argv[1]
im = Image.open(p).convert("RGB")
n = int(sys.argv[2]) if len(sys.argv) > 2 else 14
c = Counter(im.getdata())
tot = sum(c.values())
print("size", im.size, "pixels", tot)
for col, cnt in c.most_common(400):
    if cnt < tot * 0.0015:
        break
    print("#%02x%02x%02x" % col, "rgb(%d,%d,%d)" % col, cnt, "%.2f%%" % (100.0 * cnt / tot))
