# -*- coding: utf-8 -*-
import io, re
p = r"C:\Users\14012\pi-desktop-dev\video-series\promo-art\代码工程\eras_pideck.js"
s = io.open(p, encoding="utf-8").read()
segs = re.findall(r"id: '([^']+)',\s*dur: ([\d.]+)", s)
t = 0.0
for sid, dur in segs:
    d = float(dur)
    print("%-14s %6.2f - %6.2f" % (sid, t, t+d))
    t += d
print("total", t)
