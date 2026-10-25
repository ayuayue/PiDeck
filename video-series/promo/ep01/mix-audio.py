#!/usr/bin/env python3
"""v4 宣传片混音：BGM（片源 26.0s 起，120BPM）+ 按节拍网格摆放的 79.6s SFX。

设计依据 references/technique.md「Music first」：先定节拍网格（120BPM -> beat 0.5s /
bar 2.0s，音轨 26.0s 正是小节线，drop 落在影片 6.0s 的 logo->窗口形变上），
再把每个音效 cue 对到最近的整拍/半拍/16 分音上，所以每一声都踩在鼓点上。

cue 时间逐条对��� film.src.html 的 T 时间轴（不是凭感觉）。
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SFX = "C:/Users/14012/.pi/agent/skills/huashu-design/assets/sfx"
BG = os.path.join(HERE, "..", "audio-bgm-tech.mp3")
DUR = 79.6
BG_TRIM_START = 26.0  # 音轨 26.0s = 第 52 拍（小节线），drop 落在影片 6.00s
BG_GAIN = 0.44

# (影片时间, 音效文件, 音量)。时间对齐 120BPM 网格：0.5=1拍 2.0=1小节 0.25=半拍 0.125=16分音
CUES = [
    # ── 0.0~2.0 冷开场：像素 logo 逐格落位（16 格，0.085s 一格）
    (0.00, "impact/logo-reveal-v2.mp3", 0.50),
    (0.25, "ui/hover-subtle.mp3", 0.16),
    (0.50, "ui/hover-subtle.mp3", 0.16),
    (0.75, "ui/hover-subtle.mp3", 0.16),
    (1.00, "ui/hover-subtle.mp3", 0.16),
    (1.25, "ui/hover-subtle.mp3", 0.16),
    (1.50, "ui/hover-subtle.mp3", 0.16),
    # ── 3.0 换词：5 个项目同时在跑 -> 一个工作台，管住所有项目
    (2.95, "transition/whoosh-fast.mp3", 0.40),
    (3.10, "ui/focus.mp3", 0.22),
    # ── 5.8 光标点中 tile；6.0 drop + 形变开始（窗口 6.2 起生长）
    (5.75, "ui/click.mp3", 0.70),
    (6.00, "magic/transform.mp3", 0.82),
    (6.00, "transition/whoosh.mp3", 0.58),
    (6.00, "impact/drop-thud.mp3", 0.45),
    (6.25, "ui/hover-subtle.mp3", 0.18),
    (6.50, "ui/hover-subtle.mp3", 0.18),
    # ── 7.05 侧栏行错位入场 / 7.85 标签栏 / 8.75 输入框 / 9.10 指标行
    (7.00, "ui/hover-subtle.mp3", 0.18),
    (7.125, "ui/hover-subtle.mp3", 0.18),
    (7.25, "ui/hover-subtle.mp3", 0.18),
    (7.375, "ui/hover-subtle.mp3", 0.18),
    (7.50, "ui/hover-subtle.mp3", 0.18),
    (7.625, "ui/hover-subtle.mp3", 0.18),
    (7.875, "ui/hover-subtle.mp3", 0.20),
    (8.75, "ui/hover-subtle.mp3", 0.20),
    (9.125, "ui/hover-subtle.mp3", 0.20),
    # ── 9.5 镜头拉到工作台全景；9.95 字幕 1
    (9.50, "transition/whoosh.mp3", 0.32),
    (9.625, "ui/focus.mp3", 0.26),
    (14.60, "ui/focus.mp3", 0.22),
    # ── 16.0 点侧栏会话 -> 16.1 长出 Tab；17.0~19.3 打字；17.3~18.8 后端下拉
    (16.00, "ui/click.mp3", 0.66),
    (16.10, "feedback/notification-pop.mp3", 0.26),
    (16.50, "transition/whoosh-fast.mp3", 0.30),
    (17.25, "ui/toggle-on.mp3", 0.26),
    (17.50, "keyboard/type.mp3", 0.26),
    (18.00, "keyboard/type.mp3", 0.26),
    (18.50, "keyboard/type-fast.mp3", 0.30),
    (18.75, "transition/whoosh-fast.mp3", 0.26),
    # ── 19.5 发送；19.55 Tab1 进入运行
    (19.50, "ui/click.mp3", 0.64),
    (19.50, "keyboard/enter.mp3", 0.40),
    # ── 20.00~20.81 连点侧栏开 4 个 Tab（8 个 16 分音，两个一组）
    (20.00, "ui/click.mp3", 0.50),
    (20.125, "ui/click.mp3", 0.50),
    (20.25, "ui/click.mp3", 0.52),
    (20.375, "ui/click.mp3", 0.52),
    (20.50, "ui/click.mp3", 0.54),
    (20.625, "ui/click.mp3", 0.54),
    (20.75, "ui/click.mp3", 0.56),
    (20.875, "ui/click.mp3", 0.58),
    (20.25, "feedback/notification-pop.mp3", 0.26),
    # ── 五条会话流各自推进：错位 loading-tick，每 0.75s 一条
    (20.50, "progress/loading-tick.mp3", 0.22),
    (21.25, "progress/loading-tick.mp3", 0.22),
    (22.00, "progress/loading-tick.mp3", 0.22),
    (22.75, "progress/loading-tick.mp3", 0.22),
    (23.50, "progress/loading-tick.mp3", 0.22),
    (24.25, "progress/loading-tick.mp3", 0.22),
    # ── 22.2 推到标签栏特写：5 个 spinner 一起转
    (22.20, "transition/whoosh-fast.mp3", 0.30),
    (22.25, "magic/ai-process.mp3", 0.34),
    # ── 25.1 项目行琥珀点 + 原生 tooltip
    (25.00, "feedback/notification-pop.mp3", 0.30),
    (25.25, "ui/focus.mp3", 0.24),
    # ── 27.3 抓起 Tab 拖到右边；28.1 落点预览；27.9 分屏成立；31.2 拖分隔条
    (27.25, "ui/click.mp3", 0.54),
    (27.50, "transition/whoosh-fast.mp3", 0.30),
    (28.00, "feedback/notification-pop.mp3", 0.32),
    (28.10, "ui/click.mp3", 0.58),
    (28.10, "magic/transform.mp3", 0.44),
    (29.00, "magic/ai-process.mp3", 0.36),
    (29.75, "progress/loading-tick.mp3", 0.20),
    (31.25, "ui/click.mp3", 0.34),
    # ── 32.6 拉远；33.0 浮动球进场；33.6~36.2 计数滚到 5
    (32.60, "transition/whoosh.mp3", 0.34),
    (33.00, "feedback/notification-pop.mp3", 0.34),
    (33.75, "ui/toggle-on.mp3", 0.22),
    (34.50, "ui/toggle-on.mp3", 0.22),
    (35.25, "ui/toggle-on.mp3", 0.22),
    (36.00, "ui/toggle-on.mp3", 0.24),
    (36.25, "ui/focus.mp3", 0.24),
    # ── 37.9 终端滑入；38.4~39.3 敲 git；38.7~40.2 文件树级联；39.35 输出
    (37.90, "terminal/command-execute.mp3", 0.42),
    (38.25, "ui/hover-subtle.mp3", 0.18),
    (38.50, "keyboard/type.mp3", 0.28),
    (38.75, "ui/hover-subtle.mp3", 0.18),
    (39.00, "keyboard/type-fast.mp3", 0.30),
    (39.25, "ui/hover-subtle.mp3", 0.18),
    (39.35, "terminal/output-appear.mp3", 0.26),
    (40.00, "ui/hover-subtle.mp3", 0.18),
    (40.40, "transition/whoosh.mp3", 0.28),
    # ── 42.2 暂存改动 + 按钮回写
    (42.20, "ui/click.mp3", 0.68),
    (42.20, "keyboard/enter.mp3", 0.40),
    (43.00, "ui/focus.mp3", 0.24),
    # ── 45.6 镜头拉到知识卡：Pi vs DSH（两张卡 45.78/45.94，扫光 46.15）
    (45.50, "transition/whoosh.mp3", 0.38),
    (45.75, "feedback/notification-pop.mp3", 0.28),
    (46.15, "transition/whoosh-fast.mp3", 0.26),
    # 逐行对滑高亮每 2.42s 一轮（46.30 起），三轮
    (46.25, "ui/hover-subtle.mp3", 0.22),
    (48.75, "ui/hover-subtle.mp3", 0.22),
    (51.25, "ui/hover-subtle.mp3", 0.22),
    (52.75, "ui/focus.mp3", 0.24),
    # ── 53.6 PiDeck vs 裸终端：5 个终端窗口错落进场（53.88 + 0.11i）
    (53.60, "transition/whoosh.mp3", 0.36),
    (53.875, "ui/hover-subtle.mp3", 0.20),
    (54.00, "ui/hover-subtle.mp3", 0.20),
    (54.125, "ui/hover-subtle.mp3", 0.20),
    (54.25, "ui/hover-subtle.mp3", 0.20),
    (54.375, "ui/hover-subtle.mp3", 0.20),
    (54.875, "ui/focus.mp3", 0.24),
    (57.00, "ui/focus.mp3", 0.20),
    (59.25, "ui/focus.mp3", 0.22),
    # ── 61.2 11 种来源的导入芯片逐个飞入（61.34 + 0.085i，共 11 个）
    (61.20, "transition/whoosh.mp3", 0.36),
    (61.375, "ui/hover-subtle.mp3", 0.18),
    (61.50, "ui/hover-subtle.mp3", 0.18),
    (61.625, "ui/hover-subtle.mp3", 0.18),
    (61.75, "ui/hover-subtle.mp3", 0.18),
    (61.875, "ui/hover-subtle.mp3", 0.18),
    (62.00, "ui/hover-subtle.mp3", 0.18),
    (62.125, "ui/hover-subtle.mp3", 0.18),
    # 62.55 起逐个转成「已导入」（62.55 + 0.11i）
    (62.625, "feedback/notification-pop.mp3", 0.20),
    (63.00, "feedback/notification-pop.mp3", 0.20),
    (63.375, "feedback/notification-pop.mp3", 0.20),
    (63.75, "feedback/notification-pop.mp3", 0.20),
    (64.125, "feedback/notification-pop.mp3", 0.20),
    (65.00, "ui/focus.mp3", 0.24),
    # ── 67.8 BY THE NUMBERS：1714 / 42 / 11 / 1 四个数字滚动
    (67.80, "transition/whoosh.mp3", 0.34),
    (68.00, "impact/logo-reveal-v2.mp3", 0.34),
    (68.25, "ui/toggle-on.mp3", 0.24),
    (68.50, "ui/toggle-on.mp3", 0.24),
    (68.75, "ui/toggle-on.mp3", 0.24),
    (69.00, "ui/toggle-on.mp3", 0.26),
    # 42 个 provider 方块 69.30 起流进来，5 个一组
    (69.375, "ui/hover-subtle.mp3", 0.14),
    (70.125, "ui/hover-subtle.mp3", 0.14),
    (70.875, "ui/hover-subtle.mp3", 0.14),
    (71.625, "ui/hover-subtle.mp3", 0.14),
    (72.25, "ui/focus.mp3", 0.24),
    # ── 72.8 收束：6 个能力 chip（72.90 + 0.13i）
    (72.80, "feedback/notification-pop.mp3", 0.30),
    (73.00, "ui/hover-subtle.mp3", 0.20),
    (73.125, "ui/hover-subtle.mp3", 0.20),
    (73.25, "ui/hover-subtle.mp3", 0.20),
    (73.375, "ui/hover-subtle.mp3", 0.20),
    (73.50, "ui/hover-subtle.mp3", 0.20),
    (73.625, "ui/hover-subtle.mp3", 0.20),
    (74.50, "ui/focus.mp3", 0.26),
    # ── 75.6 窗口塌回 tile；77.5 tile 砸落；78.1 wordmark；78.7 tagline；79.1 双仓库
    (75.50, "transition/whoosh-fast.mp3", 0.34),
    (77.50, "impact/drop-thud.mp3", 0.74),
    (78.10, "impact/brand-stamp.mp3", 0.60),
    (78.70, "magic/sparkle.mp3", 0.24),
    (79.10, "ui/toggle-on.mp3", 0.24),
]


def main() -> int:
    out = os.path.join(HERE, "audio.wav")
    inputs = ["-ss", f"{BG_TRIM_START}", "-t", f"{DUR}", "-i", BG]
    for t, rel, _ in CUES:
        p = os.path.join(SFX, rel.replace("/", os.sep))
        if not os.path.exists(p):
            print(f"missing sfx: {p}", file=sys.stderr)
            return 2
        inputs += ["-i", p]

    chains = [
        f"[0:a]atrim=0:{DUR},asetpts=N/SR/TB,volume={BG_GAIN},lowpass=f=4000,afade=t=in:st=0:d=0.3,"
        f"afade=t=out:st={DUR - 1.5}:d=1.5[bg]"
    ]
    labels = ["[bg]"]
    for i, (t, _rel, vol) in enumerate(CUES, start=1):
        ms = int(round(t * 1000))
        chains.append(
            f"[{i}:a]adelay={ms}:all=1,volume={vol},highpass=f=700,"
            f"apad=whole_dur={DUR}[s{i}]"
        )
        labels.append(f"[s{i}]")

    n = len(labels)
    chains.append(
        "".join(labels)
        + f"amix=inputs={n}:normalize=0:dropout_transition=0,"
        "alimiter=limit=0.94:level=disabled,"
        f"afade=t=out:st={DUR - 1.2}:d=1.2[a]"
    )

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs,
           "-filter_complex", ";".join(chains), "-map", "[a]",
           "-ar", "48000", "-ac", "2", "-t", f"{DUR}", out]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        print(r.stderr.decode("utf-8", "replace")[-3000:], file=sys.stderr)
        return r.returncode
    print(f"OK {out}  ({len(CUES)} cues + BGM @ {BG_TRIM_START}s..{BG_TRIM_START + DUR}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
