# -*- coding: utf-8 -*-
import subprocess, numpy as np, os
proj = r"C:\Users\14012\pi-desktop-dev\video-series\promo-art"
p = os.path.join(proj, "output", "PiDeck-宣传片.mp4")
raw = subprocess.run(["ffmpeg","-v","error","-i",p,"-vf","fps=12,scale=320:-1,format=gray",
                      "-f","rawvideo","-pix_fmt","gray","-"], capture_output=True).stdout
n = 320*180
fr = np.frombuffer(raw, dtype=np.uint8)[:len(raw)//n*n].reshape(-1,180,320).astype(np.float32)
print("frames(12fps):", len(fr))
gx = np.abs(np.diff(fr, axis=2)).mean(axis=(1,2))   # 水平方向梯度
gy = np.abs(np.diff(fr, axis=1)).mean(axis=(1,2))   # 垂直方向梯度
edge = (gx + gy) / 2
print("edge density: min=%.2f p05=%.2f median=%.2f max=%.2f" % (edge.min(), np.percentile(edge,5), np.median(edge), edge.max()))
order = np.argsort(edge)[:8]
print("flattest 8 frames:")
for i in sorted(order):
    print("  t=%5.1fs edge=%.2f bright=%.1f" % (i/12.0, edge[i], fr[i].mean()))
band = fr[:, :int(180*0.852), :]
bb = band.mean(axis=(1,2))
print("frames with band brightness < 6:", int((bb < 6).sum()), "/", len(band))
b = bb < 6
mx = 0; cur = 0
for v in b:
    if v: cur += 1; mx = max(mx, cur)
    else: cur = 0
print("longest continuous dark run:", mx, "frames =", round(mx/12.0, 2), "s")
print("min band brightness:", round(float(bb.min()), 2), "at t =", round(float(np.argmin(bb))/12.0, 2), "s")
