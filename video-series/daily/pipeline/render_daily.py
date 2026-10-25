#!/usr/bin/env python3
"""PiDeck AI 日更 · 渲染编排。

一条整集视频的完整流程：

1. 逐屏配音（edge-tts）→ mp3 + srt
2. 解码每屏 mp3 得到**精确**时长 → 排成一条整集时间轴
3. 拼整集单页 HTML（所有屏叠一页，逐屏带 --in/--out）+ 整集一份 ASS 字幕
4. Playwright 逐帧定位 CSS 动画时间轴 → PNG 管道 → ffmpeg 编码成片

为什么第 2 步要解码：旧管线按屏各烧各的再 `-c copy` 拼接，mp3 的编码器填充
和 `-shortest` 的结束延迟会让每屏多出 1.5～2.1s，5 屏下来画面和口播能差好几秒。
用解码后的 PCM 样本数当权威时长，画面、字幕、音轨三者共用同一套秒数。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.daily_deck import DAILY, build, load_episode  # noqa: E402
from pipeline.render_motion import (  # noqa: E402
    capture_stills,
    decode_pcm,
    find_chromium,
    pcm_duration,
    render_motion,
    write_wav,
)
from pipeline.subtitles import build_ass, read_srt, shift_cues  # noqa: E402
from pipeline.timeline import build_timeline, total_duration  # noqa: E402
from templates.deck_css import FORMATS  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

TTS_PROXY = "http://127.0.0.1:7890"


def tts(
    text: str,
    out_mp3: Path,
    out_srt: Path,
    voice: str,
    rate: str,
    pitch: str,
    force: bool = False,
) -> None:
    """edge-tts 配音。已有产物且没开 --force-tts 时直接复用。"""
    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    if not force and out_mp3.exists() and out_srt.exists():
        if out_mp3.stat().st_size > 500 and out_srt.stat().st_size > 50:
            print(f"↻ 复用配音 {out_mp3.name}")
            return

    (out_mp3.with_suffix(".in.txt")).write_text(text, encoding="utf-8")
    base = [
        sys.executable, "-m", "edge_tts",
        f"--voice={voice}",
        f"--rate={rate}",
        f"--pitch={pitch}",
        f"--file={out_mp3.with_suffix('.in.txt')}",
        f"--write-media={out_mp3}",
        f"--write-subtitles={out_srt}",
    ]
    # 先走本地代理，失败再直连（境外 TTS 服务直连经常被墙）
    for extra in ([f"--proxy={TTS_PROXY}"], []):
        result = subprocess.run(base + extra, capture_output=True)
        if result.returncode == 0 and out_mp3.exists() and out_mp3.stat().st_size > 500:
            print(f"✅ 配音 {out_mp3.name}")
            return
        last = result.stderr.decode("utf-8", "replace")
    raise SystemExit(f"❌ 配音失败 {out_mp3.name}: {last}")


def render(
    episode: dict,
    script_path: Path,
    formats: list[str],
    force_tts: bool = False,
    skip_tts: bool = False,
    fps: int = 30,
    limit: float | None = None,
    stills: bool = True,
) -> list[Path]:
    date = episode.get("date", Path(script_path).stem)
    out_dir = DAILY / "out" / date
    out_dir.mkdir(parents=True, exist_ok=True)

    voice_cfg = episode.get("voice") or {}
    voice = voice_cfg.get("name", "zh-CN-YunxiNeural")
    rate = voice_cfg.get("rate", "-10%")
    pitch = voice_cfg.get("pitch", "-2Hz")

    # 1) 配音
    audio_dir = out_dir / "audio"
    slides = episode["slides"]
    for slide in slides:
        target = audio_dir / slide["id"]
        if skip_tts:
            print(f"↷ 跳过配音 {slide['id']}")
            continue
        tts(slide["narration"], target.with_suffix(".mp3"), target.with_suffix(".srt"), voice, rate, pitch, force_tts)

    # 2) 精确时长 → 整集时间轴
    pcm_parts: list[bytes] = []
    durations: list[float] = []
    for slide in slides:
        mp3 = audio_dir / f"{slide['id']}.mp3"
        if not mp3.exists():
            raise SystemExit(f"❌ 缺音频 {mp3}（先去掉 --no-tts 跑一次配音）")
        pcm = decode_pcm(mp3)
        pcm_parts.append(pcm)
        durations.append(pcm_duration(pcm))
    timings = build_timeline(durations)
    total = total_duration(timings)
    print(f"⏱ 整集时长 {total:.2f}s（{len(slides)} 屏）")

    # 3) 整集音轨 + 整集字幕 + 整集 HTML
    audio_path = write_wav(out_dir / "audio" / "episode.wav", b"".join(pcm_parts))
    written = build(episode, out_dir, timings)

    videos: list[Path] = []
    for fmt in formats:
        spec = FORMATS[fmt]
        cues = []
        for slide, timing in zip(slides, timings):
            srt = audio_dir / f"{slide['id']}.srt"
            if srt.exists():
                cues.extend(shift_cues(read_srt(srt), timing.start))
        ass_path = build_ass(
            cues,
            out_dir / "subtitles" / fmt / "episode.ass",
            spec["width"],
            spec["height"],
            spec["subtitle"],
        )
        out_mp4 = out_dir / f"{date}-{fmt}.mp4"
        render_motion(
            written[fmt],
            spec["width"],
            spec["height"],
            fps,
            total,
            audio_path,
            ass_path,
            out_mp4,
            limit=limit,
        )
        videos.append(out_mp4)
        print(f"✅ {fmt}: {out_mp4.name}  {out_mp4.stat().st_size / 1024 / 1024:.1f}MB")

        if stills:
            moments = [
                (slide["id"], min(timing.start + min(timing.duration / 2, 1.4), total - 0.05))
                for slide, timing in zip(slides, timings)
            ]
            capture_stills(written[fmt], spec["width"], spec["height"], moments, out_dir / "shots" / fmt)
    return videos


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="渲染 PiDeck AI 日更成片")
    parser.add_argument("--script", required=True, help="日更脚本 JSON")
    parser.add_argument("--formats", default="16x9,3x4")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--force-tts", action="store_true")
    parser.add_argument("--no-tts", action="store_true")
    parser.add_argument("--limit", type=float, default=None, help="只渲染前 N 秒（试片）")
    parser.add_argument("--no-stills", action="store_true")
    args = parser.parse_args()

    script_path = Path(args.script)
    episode = load_episode(script_path)
    formats = [fmt.strip() for fmt in args.formats.split(",") if fmt.strip()]
    videos = render(
        episode,
        script_path,
        formats,
        force_tts=args.force_tts,
        skip_tts=args.no_tts,
        fps=args.fps,
        limit=args.limit,
        stills=not args.no_stills,
    )

    date = episode.get("date", script_path.stem)
    out_dir = DAILY / "out" / date
    manifest = {
        "date": date,
        "title": episode.get("title", ""),
        "episode": episode.get("episode", 1),
        "kind": episode.get("kind", ""),
        "videos": [
            {
                "file": path.name,
                "durationSec": round(_duration(path), 2),
            }
            for path in videos
        ],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"📦 manifest: {out_dir / 'manifest.json'}")


def _duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True,
    )
    try:
        return float(result.stdout.decode().strip())
    except ValueError:
        return 0.0


if __name__ == "__main__":
    main()
