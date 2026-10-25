#!/usr/bin/env python3
"""PiDeck AI 日更 · 幻灯片视觉层（HTML/CSS 设计语言）。

两块内容：
1. `TOKENS` / `_common()` / `CSS_16x9` / `CSS_3x4`：静态外观（沿用原 EP 系列的暗色
   桌面风格，token 不变）。
2. 动效层：整集所有屏叠在同一页 HTML 上，每屏一个绝对定位图层，靠 `--in` / `--out`
   两个 CSS 变量驱动入场与退场；背景常驻并缓慢漂移，底部进度条随时间轴推进。

动效全部写成 CSS keyframes，渲染时由 Playwright 把 `currentTime` 定位到每一帧，
所以这里不需要任何 JS 动画库，也不需要 ffmpeg 侧的推镜表达式。
"""

TOKENS = """
:root {
  --bg: #0e1116;
  --surface: #171b22;
  --surface-2: #1d222b;
  --line: rgba(255, 255, 255, 0.08);
  --text: #e8eaed;
  --muted: #9aa3b2;
  --dim: #6b7380;
  --accent: #d4a574;
  --accent-soft: rgba(212, 165, 116, 0.14);
  --ok: #6fbf8a;
  --bad: #e07a6a;
  --font: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --mono: "Cascadia Code", "Consolas", "SFMono-Regular", monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #000;
  font-family: var(--font);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
"""


def _common() -> str:
    """两个画幅共用的组件样式 + 动效层。"""
    return """
/* ---------- 画幅框架 ---------- */
.slide {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.deck-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(1200px 620px at 100% -12%, rgba(212, 165, 116, 0.10), transparent 58%),
    radial-gradient(900px 520px at -8% 108%, rgba(88, 120, 160, 0.10), transparent 55%);
  animation: bgDrift var(--total, 60s) linear both;
}
/* 整片首尾的淡入淡出：让成片有“开始/结束”，而不是硬切 */
.deck-fade {
  position: absolute;
  inset: 0;
  z-index: 6;
  background: #000;
  pointer-events: none;
  animation: fadeEdges var(--total, 60s) linear both;
}
.deck-bg::after {
  content: "";
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.016) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.016) 1px, transparent 1px);
  background-size: var(--grid) var(--grid);
}

/* ---------- 固定 chrome ---------- */
.mast {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-mast);
  color: var(--muted);
  z-index: 2;
}
.brand { display: flex; align-items: center; gap: 12px; color: var(--text); font-weight: 600; }
.brand-mark {
  width: var(--mark);
  height: var(--mark);
  border-radius: 8px;
  background: linear-gradient(135deg, var(--accent), #8c6a45);
}
.ep-tag {
  font-family: var(--mono);
  font-size: var(--fs-tag);
  padding: var(--pad-tag) var(--pad-tag-x);
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--accent);
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-foot);
  color: var(--dim);
  z-index: 2;
}
.progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.05);
  z-index: 3;
}
.progress > i {
  display: block;
  height: 100%;
  width: 100%;
  transform-origin: left center;
  transform: scaleX(0);
  background: linear-gradient(90deg, rgba(212, 165, 116, 0.5), var(--accent));
  animation: progressGrow var(--total, 60s) linear both;
}

/* ---------- 画面图层 ---------- */
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  z-index: 1;
}
.layer {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  animation: layerOut var(--trans, 0.42s) cubic-bezier(0.45, 0, 0.2, 1) both;
  animation-delay: var(--out, 0s);
}
.layer-in {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 带整屏截图的页：底部给烧录字幕留出安全区，顶部跟 mast 留一点气 */
.layer.has-img .layer-in {
  padding: 28px 0 var(--sub-band, 0px);
}

/* ---------- 入场动效（delay = --in + --d，--in 由时间轴算好） ---------- */
.rise {
  animation: riseIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: calc(var(--in, 0s) + var(--d, 0s));
}
.rise-soft {
  animation: riseSoft 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: calc(var(--in, 0s) + var(--d, 0s));
}
.pop {
  animation: popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  animation-delay: calc(var(--in, 0s) + var(--d, 0s));
}
.rule {
  width: var(--rule-w);
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--accent), rgba(212, 165, 116, 0));
  transform-origin: left center;
  animation: wipeIn 0.55s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: calc(var(--in, 0s) + var(--d, 0s));
}
.reveal {
  overflow: hidden;
  animation: reveal 0.62s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: calc(var(--in, 0s) + var(--d, 0s));
}
.reveal img {
  animation: settle 6s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: calc(var(--in, 0s) + var(--d, 0s));
}

@keyframes riseIn {
  from { opacity: 0; transform: translate3d(0, 28px, 0); }
  to { opacity: 1; transform: none; }
}
@keyframes riseSoft {
  from { opacity: 0; transform: translate3d(0, 14px, 0); }
  to { opacity: 1; transform: none; }
}
@keyframes popIn {
  from { opacity: 0; transform: scale(0.5) rotate(-6deg); }
  70% { opacity: 1; transform: scale(1.08) rotate(1deg); }
  to { opacity: 1; transform: none; }
}
@keyframes wipeIn {
  from { transform: scaleX(0); opacity: 0.2; }
  to { transform: scaleX(1); opacity: 1; }
}
@keyframes reveal {
  from { clip-path: inset(0 0 100% 0 round var(--radius)); }
  to { clip-path: inset(0 0 0 0 round var(--radius)); }
}
@keyframes settle {
  from { transform: scale(1.04); }
  to { transform: scale(1); }
}
@keyframes layerOut {
  from { opacity: 1; transform: none; }
  to { opacity: 0; transform: translate3d(0, -20px, 0) scale(0.992); }
}
@keyframes bgDrift {
  from { transform: scale(1.02) translate3d(0, 0, 0); }
  to { transform: scale(1.1) translate3d(-1.2%, -1%, 0); }
}
@keyframes fadeEdges {
  0% { opacity: 1; }
  1.2% { opacity: 0; }
  99.2% { opacity: 0; }
  100% { opacity: 1; }
}
/* 产品截图的缓慢推镜：整段画面有呼吸感，而不是死图 */
@keyframes pushIn {
  from { transform: scale(1); }
  to { transform: scale(1.045); }
}
@keyframes progressGrow {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}

/* 静态预览/静帧：停在动画终态 */
.deck.static *,
.deck.static *::before,
.deck.static *::after {
  animation: none !important;
}

/* ---------- 正文组件 ---------- */
h1 { font-size: var(--fs-h1); line-height: 1.12; font-weight: 700; letter-spacing: -0.5px; }
h2 { font-size: var(--fs-h2); line-height: 1.2; font-weight: 700; letter-spacing: -0.3px; }
.lead { font-size: var(--fs-lead); line-height: 1.5; color: var(--muted); }
.kicker {
  display: inline-block;
  align-self: flex-start;
  font-family: var(--mono);
  font-size: var(--fs-kicker);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 8px 14px;
  border-radius: 999px;
  margin-bottom: var(--gap-l);
}
.bullets { list-style: none; display: flex; flex-direction: column; gap: var(--gap-m); }
.bullets li {
  display: grid;
  grid-template-columns: var(--bullet-n) 1fr;
  align-items: start;
  gap: var(--gap-m);
  font-size: var(--fs-body);
  line-height: 1.45;
  color: var(--text);
}
.bullets .n {
  width: var(--bullet-n);
  height: var(--bullet-n);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: var(--fs-num);
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid rgba(212, 165, 116, 0.25);
}
.steps { list-style: none; display: flex; flex-direction: column; gap: var(--gap-m); }
.steps li {
  display: grid;
  grid-template-columns: var(--bullet-n) 1fr;
  align-items: start;
  gap: var(--gap-m);
  font-size: var(--fs-body);
  line-height: 1.45;
}
.shot { display: flex; flex-direction: column; }
.shot-img {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius);
}
.shot-img img {
  width: 100%;
  height: auto;
  max-height: 100%;
  object-fit: contain;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  display: block;
}
.shot-v { flex: none; }
.shot-v .shot-img { flex: none; }
.shot-v .shot-img img { width: 100%; height: auto; }
.shot-2col {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 0.88fr 1.12fr;
  gap: 48px;
  align-items: center;
}
.shot-copy h2 { font-size: 54px; }
.shot-cap { font-size: var(--fs-cap); color: var(--muted); line-height: 1.5; }
.quote {
  font-size: var(--fs-quote);
  line-height: 1.35;
  padding: var(--pad-quote);
  border-left: 4px solid var(--accent);
  background: var(--surface);
  border-radius: var(--radius);
}
.chip {
  display: inline-flex;
  align-items: center;
  font-size: var(--fs-chip);
  padding: var(--pad-chip) var(--pad-chip-x);
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text);
}
.cta-row { display: flex; flex-wrap: wrap; gap: var(--gap-m); }
"""


CSS_16x9 = TOKENS + """
.slide {
  width: 1920px;
  height: 1080px;
  padding: 64px 96px 56px;
  --grid: 48px;
  --sub-band: 230px;
  --gap-s: 16px;
  --gap-m: 26px;
  --gap-l: 40px;
  --mark: 30px;
  --fs-mast: 24px;
  --fs-tag: 19px;
  --pad-tag: 8px;
  --pad-tag-x: 16px;
  --fs-foot: 20px;
  --fs-h1: 82px;
  --fs-h2: 60px;
  --fs-lead: 36px;
  --fs-body: 34px;
  --fs-num: 18px;
  --fs-cap: 24px;
  --fs-quote: 42px;
  --fs-kicker: 20px;
  --fs-chip: 26px;
  --pad-chip: 10px;
  --pad-chip-x: 22px;
  --bullet-n: 40px;
  --radius: 20px;
  --pad-quote: 32px 36px;
  --rule-w: 168px;
}
""" + _common()


CSS_3x4 = TOKENS + """
.slide {
  width: 1080px;
  height: 1440px;
  padding: 72px 72px 60px;
  --grid: 40px;
  --sub-band: 240px;
  --gap-s: 14px;
  --gap-m: 26px;
  --gap-l: 36px;
  --mark: 30px;
  --fs-mast: 24px;
  --fs-tag: 19px;
  --pad-tag: 8px;
  --pad-tag-x: 16px;
  --fs-foot: 20px;
  --fs-h1: 68px;
  --fs-h2: 52px;
  --fs-lead: 34px;
  --fs-body: 34px;
  --fs-num: 18px;
  --fs-cap: 26px;
  --fs-quote: 40px;
  --fs-kicker: 20px;
  --fs-chip: 26px;
  --pad-chip: 10px;
  --pad-chip-x: 22px;
  --bullet-n: 40px;
  --radius: 20px;
  --pad-quote: 30px 32px;
  --rule-w: 132px;
}
""" + _common()


FORMATS = {
    "16x9": {
        "css": CSS_16x9,
        "width": 1920,
        "height": 1080,
        "subtitle": {
            "style": "Daily",
            "font": "Microsoft YaHei",
            "size": 46,
            "margin_h": 140,
            "margin_v": 140,
            "max_em": 33,
        },
    },
    "3x4": {
        "css": CSS_3x4,
        "width": 1080,
        "height": 1440,
        "subtitle": {
            "style": "Daily",
            "font": "Microsoft YaHei",
            "size": 44,
            "margin_h": 60,
            "margin_v": 150,
            "max_em": 20,
        },
    },
}
