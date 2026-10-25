# -*- coding: utf-8 -*-
from PIL import Image
import subprocess, os, shutil
proj = r"C:\Users\14012\pi-desktop-dev\video-series\promo-art"
d = os.path.join(proj, "assets", "check")
shutil.rmtree(d, ignore_errors=True)
os.makedirs(d, exist_ok=True)
subprocess.run(["ffmpeg","-y","-v","error","-i",os.path.join(proj,"output","PiDeck-宣传片.mp4"),
                "-vf","fps=1/7,scale=640:-1","-q:v","2",os.path.join(d,"c_%02d.jpg")], check=True)
files = sorted(f for f in os.listdir(d) if f.startswith("c_"))
tw, th = 640, 360
cols = 4
rows = (len(files)+cols-1)//cols
sheet = Image.new("RGB",(tw*cols, th*rows),"#000")
for i,f in enumerate(files):
    im = Image.open(os.path.join(d,f)).convert("RGB").resize((tw,th), Image.LANCZOS)
    sheet.paste(im, ((i%cols)*tw, (i//cols)*th))
sheet.save(os.path.join(d,"sheet.jpg"), quality=90)
print("sheet", sheet.size, len(files))
