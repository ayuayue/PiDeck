#!/usr/bin/env python3
"""PiDeck AI 日更 · 字幕（SRT 解析 + 整集 ASS 生成）。

两个坑（都在这里固化成纯函数，便于单测）：

1. libass 不会给无空格的中文断行，长句会顶出画面两侧 → 预先折好再写 ASS 硬换行。
2. 走 `subtitles=xxx.srt:force_style=...` 时，ffmpeg 内部把 SRT 当成 384×288 的
   脚本分辨率，libass 再按画面尺寸放大——26 号字在 1080p 下会被放大到近 100px，
   字幕直接盖住画面 → 必须自己写 ASS，并显式写死 PlayResX/PlayResY。

整集只生成一份 ASS：分屏各烧各的会让字幕跟着画面一起闪，字幕在整条时间轴上
应该是连续的。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

#: 字幕淡入淡出（毫秒）。0 = 不加
FADE_MS = 130

#: edge-tts 断句有时会把标点留在下一条 cue 开头（如「，下期讲…」），这里去掉
_EDGE_PUNCT = "，。！？；：、,.!?;:～~…—-"


def trim_cue_text(text: str) -> str:
    """去掉 cue 首尾的悬空标点与空白。

    edge-tts 按短语断句，偶尔把句末标点甩到下一条的开头（字幕上会看到孤零零的
    「，」），断句处的悬空标点一律削掉。
    """
    cleaned = text.strip()
    while cleaned and cleaned[0] in _EDGE_PUNCT:
        cleaned = cleaned[1:].lstrip()
    while cleaned and cleaned[-1] in _EDGE_PUNCT:
        cleaned = cleaned[:-1].rstrip()
    return cleaned


@dataclass(frozen=True)
class Cue:
    """一条字幕（秒，全片坐标系）。"""

    start: float
    end: float
    text: str


def _char_em(ch: str) -> float:
    """粗略字宽：CJK 与全角标点算 1 em，ASCII 算 0.5 em。"""
    return 1.0 if ord(ch) > 0x2E80 else 0.5


def wrap_cjk(text: str, max_em: float) -> str:
    """按宽度手工折行。

    libass 不会给无空格的中文断行（它只在空格/连字符处断），长句会直接顶出画面两侧。
    这里先自己折好，再用 ASS 的 \\N 硬换行。避头尾：行首不落标点，行尾不挂开引号。
    """
    lines: list[str] = []
    cur = ""
    cur_w = 0.0
    for ch in text:
        if ch == "\n":
            lines.append(cur)
            cur, cur_w = "", 0.0
            continue
        w = _char_em(ch)
        if cur_w + w > max_em and cur:
            # 尽量在标点后断行：向前找最近的标点/空格
            cut = len(cur)
            for i in range(len(cur) - 1, max(-1, len(cur) - 12), -1):
                if cur[i] in "，。！？；：、,.!?;: ":
                    cut = i + 1
                    break
            # 避头尾：行首不能是收尾标点
            while cut < len(cur) and cur[cut] in "，。！？；：、,.!?;:":
                cut += 1
            lines.append(cur[:cut])
            cur = cur[cut:]
            cur_w = sum(_char_em(c) for c in cur)
        cur += ch
        cur_w += w
    if cur:
        lines.append(cur)
    return "\n".join(lines)


def _srt_seconds(ts: str) -> float:
    """SRT 时间戳 "00:00:01,250" → 秒。"""
    h, m, rest = ts.strip().replace(",", ".").split(":")
    return int(h) * 3600 + int(m) * 60 + float(rest)


def parse_srt(raw: str) -> list[Cue]:
    """解析 SRT 文本为 cue 列表（秒）。"""
    blocks = re.split(r"\r?\n\r?\n", raw.strip())
    cues: list[Cue] = []
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2 or "-->" not in lines[1]:
            continue
        start_s, end_s = [part.strip() for part in lines[1].split("-->")]
        text = "\n".join(lines[2:]).strip()
        if not text:
            continue
        cues.append(Cue(start=_srt_seconds(start_s), end=_srt_seconds(end_s), text=text))
    return cues


def read_srt(path: Path) -> list[Cue]:
    return parse_srt(path.read_text(encoding="utf-8-sig"))


def shift_cues(cues: list[Cue], offset: float) -> list[Cue]:
    """整体平移一段字幕（用于把分屏 SRT 拼成整集时间轴）。"""
    return [Cue(start=c.start + offset, end=c.end + offset, text=c.text) for c in cues]


def to_ass_time(seconds: float) -> str:
    """秒 → ASS 时间 "H:MM:SS.cc"。"""
    total = max(0.0, float(seconds))
    h = int(total // 3600)
    m = int((total % 3600) // 60)
    s = total % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def build_ass(
    cues: list[Cue],
    out_ass: Path,
    width: int,
    height: int,
    style: dict,
    fade_ms: int = FADE_MS,
) -> Path:
    """把 cue 列表写成 ASS 文件，显式写死 PlayResX/PlayResY = 画面尺寸。"""
    out_ass.parent.mkdir(parents=True, exist_ok=True)
    max_em = style.get("max_em", 0)
    events: list[str] = []
    for cue in cues:
        raw = trim_cue_text(cue.text)
        if not raw:
            continue
        text = wrap_cjk(raw, max_em) if max_em else raw
        text = text.replace("\n", "\\N")
        if fade_ms:
            text = f"{{\\fad({fade_ms},{fade_ms})}}{text}"
        events.append(
            # Dialogue 的字段数必须与 Format 声明的 10 个一致：
            # Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
            # 多写一个空字段，libass 会把正文顶偏，并在行首多出一个杂字符。
            f"Dialogue: 0,{to_ass_time(cue.start)},{to_ass_time(cue.end)},{style['style']},,0,0,0,,{text}"
        )

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: {style['style']},{style['font']},{style['size']},&H00FFFFFF,&H00FFFFFF,&H00000000,&HC0000000,0,0,0,0,100,100,0,0,3,1,0,2,{style['margin_h']},{style['margin_h']},{style['margin_v']},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    out_ass.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return out_ass
