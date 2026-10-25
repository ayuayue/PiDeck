#!/usr/bin/env python3
"""PiDeck AI 日更 · 整集时间轴。

把「每屏旁白有多长」这一件事换算成整条片子的秒数：每一屏从哪秒开始、到哪秒结束，
画面层的入场/退场时刻在哪，字幕整体要偏移多少。

为什么单独成文件：画面层、字幕、音轨三样东西必须用同一套秒数，任何一处自己算
时间就会漂移。这里只做纯计算，不碰 IO，所以能单测。
"""
from __future__ import annotations

from dataclasses import dataclass

#: 上一屏退场与下一屏入场重叠的时长（秒）——交叉溶解，不留黑场
TRANSITION = 0.28

#: 画面内容比口播提前多久开始入场（秒）。口播是「说到哪」，画面提前一点起手更顺
ENTER_LEAD = 0.30


@dataclass(frozen=True)
class SlideTiming:
    """一屏的时间位置（秒，全片坐标系）。"""

    index: int
    start: float
    duration: float

    @property
    def end(self) -> float:
        return self.start + self.duration


@dataclass(frozen=True)
class LayerWindow:
    """一屏画面层的入场/退场时刻。

    ``in`` 是内容开始起手的时刻，``out`` 是这一层开始淡出的时刻。
    两者与相邻屏重叠，形成交叉溶解。
    """

    index: int
    start: float
    duration: float
    enter_at: float
    exit_at: float

    @property
    def end(self) -> float:
        return self.start + self.duration


def build_timeline(durations: list[float]) -> list[SlideTiming]:
    """把每屏时长排成一条连续时间轴。"""
    timings: list[SlideTiming] = []
    cursor = 0.0
    for index, duration in enumerate(durations):
        value = max(0.0, float(duration))
        timings.append(SlideTiming(index=index, start=cursor, duration=value))
        cursor += value
    return timings


def estimate_durations(slides: list[dict], chars_per_sec: float = 4.4) -> list[float]:
    """没配音时按字数估时长，只用于排版预览（成片一律用真实音频时长）。"""
    return [
        max(1.0, len(str(slide.get("narration", "")).strip()) / chars_per_sec)
        for slide in slides
    ]


def total_duration(timings: list[SlideTiming]) -> float:
    return sum(t.duration for t in timings)


def layer_windows(timings: list[SlideTiming]) -> list[LayerWindow]:
    """算出每屏画面层的入场/退场时刻。

    规则：
    - 入场 = 口播开始前 ENTER_LEAD 秒（第一屏就是 0，片子开头直接起手）
    - 退场 = 下一屏入场时刻（即上一屏口播结束前 ENTER_LEAD 秒），末屏在片尾淡出
    """
    if not timings:
        return []
    count = len(timings)
    windows: list[LayerWindow] = []
    for index, timing in enumerate(timings):
        enter_at = max(0.0, timing.start - ENTER_LEAD)
        if index < count - 1:
            exit_at = max(enter_at, timings[index + 1].start - ENTER_LEAD)
        else:
            exit_at = max(enter_at, timing.end - TRANSITION)
        windows.append(
            LayerWindow(
                index=index,
                start=timing.start,
                duration=timing.duration,
                enter_at=enter_at,
                exit_at=exit_at,
            )
        )
    return windows
