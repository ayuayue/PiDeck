from PIL import Image
from collections import Counter
import os, shutil

out = r"C:\Users\14012\pi-desktop-dev\video-series\promo-art\素材"
os.makedirs(out, exist_ok=True)
REPO = r"C:\Users\14012\pi-desktop-dev"

SRC = {
  "live":   REPO + r"\video-series\promo\ref\live-1920.png",   # 1920x1080 浅色主窗口
  "term":   REPO + r"\docs\images\terminal.png",                 # 2560x1380 终端
  "slash":  REPO + r"\docs\images\slash-commands.png",          # 2560x1380 斜杠命令
  "hero":   REPO + r"\docs\images\readme\hero.png",             # 2560x1392 后端下拉
  "now":    REPO + r"\video-series\promo-art\素材\win-full.png",# 2578x1398 实时窗口
}
for k, p in SRC.items():
    im = Image.open(p).convert("RGB")
    print(k, im.size)
    if k != "now":
        im.save(os.path.join(out, "src_" + k + ".png"))

def crop(src, box, name):
    im = Image.open(os.path.join(out, "src_" + src + ".png")).convert("RGB")
    c = im.crop(box)
    c.save(os.path.join(out, name))
    print("crop", name, c.size)

# live: 1920x1080
crop("live", (0, 250, 620, 598), "c_sidebar.png")        # 侧栏项目树 16:9
crop("live", (320, 260, 1560, 958), "c_timeline.png")     # 中栏时间线 16:9
crop("live", (320, 0, 1560, 698), "c_tabs.png")           # 标签栏+上半屏
crop("live", (1450, 250, 1920, 514), "c_git.png")         # 右侧改动树 16:9
crop("live", (320, 940, 1560, 1080), "c_status.png")      # 底部状态栏
crop("live", (30, 6, 78, 48), "c_logo.png")               # logo 像素
crop("live", (320, 820, 1560, 1080), "c_composer.png")    # 输入框

# term: 2560x1380
crop("term", (410, 820, 640, 1100), "c_shellpick.png")    # shell 选择下拉
crop("term", (220, 1090, 700, 1380), "c_termout.png")    # 终端输出
crop("term", (1740, 55, 2560, 245), "c_stats.png")       # 顶部用量条
crop("term", (2230, 100, 2560, 620), "c_srpanel.png")    # 右侧源代码管理

# slash: 2560x1380
crop("slash", (560, 675, 1230, 1155), "c_palette.png")   # 命令面板
crop("slash", (2230, 100, 2560, 700), "c_srpanel2.png")   # 右侧栏

# hero: 2560x1392
crop("hero", (940, 590, 1090, 730), "c_backdrop.png")     # Pi/DSH/生图 下拉
crop("hero", (30, 30, 250, 420), "c_projects.png")       # 项目列表

# 真实配色统计（去掉大面积白底）
for k in ("live", "term", "slash"):
    im = Image.open(os.path.join(out, "src_" + k + ".png")).convert("RGB")
    c = Counter(im.getdata())
    tot = sum(c.values())
    picked = [(("#%02x%02x%02x" % col), cnt) for col, cnt in c.most_common(400) if cnt > tot * 0.002]
    print(k, "top:", picked[:16])

# logo 放大看像素
im = Image.open(os.path.join(out, "c_logo.png")).resize((480, 420), Image.NEAREST)
im.save(os.path.join(out, "c_logo_zoom.png"))
print("logo colors:", [("#%02x%02x%02x" % k2, v) for k2, v in Counter(Image.open(os.path.join(out, "c_logo.png")).getdata()).most_common(12)])
