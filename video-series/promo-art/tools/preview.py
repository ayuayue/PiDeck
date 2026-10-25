# -*- coding: utf-8 -*-
from PIL import Image
import subprocess, os, tempfile
proj = r"C:\Users\14012\pi-desktop-dev\video-series\promo-art"
d = tempfile.mkdtemp()
times = [1, 8, 16, 24, 30, 38, 45, 52]
for t in times:
    subprocess.run(["ffmpeg","-y","-v","error","-ss",str(t),"-i",os.path.join(proj,"output","PiDeck-宣传片.mp4"),
                    "-frames:v","1","-vf","scale=640:-1","-q:v","2",os.path.join(d,"t%02d.jpg"%t)], check=True)
tw, th = 640, 360
sheet = Image.new("RGB",(tw*4, th*2),"#111")
for i,t in enumerate(times):
    im = Image.open(os.path.join(d,"t%02d.jpg"%t)).convert("RGB").resize((tw,th), Image.LANCZOS)
    sheet.paste(im, ((i%4)*tw, (i//4)*th))
out = os.path.join(proj, "output", "preview.jpg")
sheet.save(out, quality=93)
print(out, sheet.size)
