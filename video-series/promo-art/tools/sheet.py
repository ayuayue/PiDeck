# -*- coding: utf-8 -*-
from PIL import Image
import os, glob
d = r"C:\Users\14012\pi-desktop-dev\video-series\promo-art\代码工程\stills_test"
files = sorted(glob.glob(os.path.join(d, "*.png")))
tw, th = 480, 270
cols = 3
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (tw * cols, th * rows), "#111111")
for i, f in enumerate(files):
    im = Image.open(f).convert("RGB").resize((tw, th), Image.LANCZOS)
    sheet.paste(im, ((i % cols) * tw, (i // cols) * th))
out = r"C:\Users\14012\pi-desktop-dev\video-series\promo-art\assets\sheet_v1.jpg"
sheet.save(out, quality=88)
print("sheet", sheet.size, "->", out, "files:", len(files))
