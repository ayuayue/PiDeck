# -*- coding: utf-8 -*-
import subprocess, numpy as np
proj = r"C:\Users\14012\pi-desktop-dev\video-series\promo-art"
# 按 film_gate 的口径：12fps、320 宽灰度、屏蔽字幕带
for v in ("v8", "v12", "v15"):
    p = proj + ("\\成片_v8.mp4" if v == "v8" else "\\成片_%s.mp4" % v)
    import os
    if not os.path.exists(p):
        print(v, "missing"); continue
    raw = subprocess.run(["ffmpeg","-v","error","-i",p,"-vf","fps=12,scale=320:-1,format=gray",
                          "-f","rawvideo","-pix_fmt","gray","-"], capture_output=True).stdout
    n = 320*180
    frames = np.frombuffer(raw, dtype=np.uint8)[:len(raw)//n*n].reshape(-1,180,320).astype(np.float32)
    d = np.abs(np.diff(frames, axis=0)).mean(axis=(1,2))
    # 屏蔽底部字幕带 (0.852 以下)
    band = frames.shape[1]
    cut = int(band*0.852)
    d2 = np.abs(np.diff(frames[:, :cut], axis=0)).mean(axis=(1,2))
    print(v, "frames", len(frames), "mean d", round(float(d.mean()),3), "fast(>=9) all", round(float((d>=9).mean()),4),
          "| banded mean", round(float(d2.mean()),3), "fast", round(float((d2>=9).mean()),4),
          "max", round(float(d.max()),1))
