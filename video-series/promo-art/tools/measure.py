# -*- coding: utf-8 -*-
from PIL import Image
from collections import Counter
import os, json

A = r"C:\Users\14012\pi-desktop-dev\video-series\promo-art\assets"
out = {}

def load(n):
    return Image.open(os.path.join(A, n)).convert("RGB")

def amberish(p):
    r, g, b = p
    return r > 150 and 90 < g < 200 and b < 130 and (r - b) > 60

def find_amber(im, x0, x1, y0, y1):
    px = im.load()
    hits = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            if amberish(px[x, y]):
                hits.append((x, y))
                break
    return hits

live = load("src_live.png")
out["live_size"] = live.size
# 标签栏里的琥珀色 spinner（y 8..36）
out["live_tab_amber"] = find_amber(live, 330, 900, 8, 36)
# 侧栏会话圆点（x 50..120, y 330..620）
out["live_sidebar_dots"] = find_amber(live, 50, 130, 330, 620)
# 右侧面板分隔（x 1490..1520 列扫描）
px = live.load()
seps = [x for x in range(1400, 1560) if sum(px[x, 700]) < 720]
out["live_right_panel_x"] = seps[:8]
# 侧栏分隔
seps2 = [x for x in range(260, 330) if sum(px[x, 700]) < 740]
out["live_sidebar_x"] = seps2[:8]
# 状态栏行（找 y）
rows = [y for y in range(1000, 1070) if sum(px[700, y]) < 745]
out["live_status_y"] = (rows[0], rows[-1]) if rows else None

win = load("win-full.png")
out["win_size"] = win.size
out["win_tab_amber"] = find_amber(win, 430, 1200, 10, 48)
out["win_sidebar_dots"] = find_amber(win, 60, 180, 420, 900)

term = load("src_term.png")
out["term_size"] = term.size
out["term_powshell_amber"] = find_amber(term, 200, 800, 1100, 1300)
out["term_shellpick_amber"] = find_amber(term, 300, 700, 850, 1150)

slash = load("src_slash.png")
out["slash_size"] = slash.size
out["slash_green"] = [ (x,y) for (x,y) in find_amber(slash, 500, 1300, 700, 1000) ][:20]
pxs = slash.load()
greens = []
for y in range(700, 1000):
    for x in range(500, 1300):
        r, g, b = pxs[x, y]
        if g > 200 and g - r > 12 and g - b > 12:
            greens.append((x, y)); break
out["slash_green_rows"] = greens[:30]

hero = load("src_hero.png")
out["hero_size"] = hero.size
out["hero_check"] = find_amber(hero, 900, 1120, 580, 740)

for k, v in out.items():
    print(k, "=", v)
