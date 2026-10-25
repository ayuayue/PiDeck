# -*- coding: utf-8 -*-
import subprocess, numpy as np, os
proj = r"C:\Users\14012\pi-desktop-dev\video-series\promo-art"
p = os.path.join(proj, "成片_v20.mp4")
raw = subprocess.run(["ffmpeg","-v","error","-i",p,"-vf","fps=12,scale=320:-1,format=gray",
                      "-f","rawvideo","-pix_fmt","gray","-"], capture_output=True).stdout
n = 320*180
fr = np.frombuffer(raw, dtype=np.uint8)[:len(raw)//n*n].reshape(-1,180,320).astype(np.float32)
out = []
for s in range(54):
    seg = fr[s*12:(s+1)*12]
    if len(seg)==0: break
    out.append("%2ds m=%5.1f max=%3d std=%5.1f" % (s, seg.mean(), seg.max(), seg.std()))
print("\n".join(out))
