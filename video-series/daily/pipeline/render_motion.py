#!/usr/bin/env python3
"""PiDeck AI 日更 · 逐帧渲染。

画面动画全部写在一页 HTML 里（CSS keyframes），这里只做一件事：把浏览器动画时间轴
按 30fps 一帧一帧定位，截图后用管道喂给 ffmpeg 编码。

为什么不用 ffmpeg 滤镜做动画：
- ffmpeg 的 `crop` 表达式里的 `t` 不会逐帧重算，拿它做推镜会直接
  `Nothing was written into output file, because at least one of its streams received no packets`；
- 入场 stagger、弹性缓动、交叉溶解这些在浏览器里算好最省事，ffmpeg 只负责拼帧。

关键手法：`document.getAnimations()` 拿到所有 CSS 动画 → `pause()` → 把
`currentTime` 设成当前帧的秒数。CSS animation-delay 的语义会被完整还原
（delay 3s 的动画在 currentTime=3.2s 时才可见），截图前 Playwright 会强制同步渲染，
不需要 sleep。
"""
from __future__ import annotations

import math
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError

#: 音频统一采样率（edge-tts 原生 24kHz 单声道）
SAMPLE_RATE = 24000

#: 把页面上所有动画定位到指定时刻（毫秒）
SCRUB_JS = """
(t) => {
  for (const a of document.getAnimations()) {
    a.pause();
    a.currentTime = t;
  }
}
"""


def find_chromium() -> str | None:
    """找本机 playwright 的 chromium（Windows）。"""
    root = Path.home() / "AppData/Local/ms-playwright"
    if not root.exists():
        return None
    candidates = sorted(root.glob("chromium-*/chrome-win*/chrome.exe"), reverse=True)
    return str(candidates[0]) if candidates else None


def decode_pcm(mp3: Path, rate: int = SAMPLE_RATE) -> bytes:
    """把 mp3 解成 16bit PCM 原始字节。

    用解码后的样本数当权威时长：mp3 容器时长带编码器填充，逐屏 `-shortest` 拼片
    时会累积出 1.5～2.1s 的漂移，直接用 PCM 样本数就没有这问题。
    """
    result = subprocess.run(
        [
            "ffmpeg", "-v", "error",
            "-i", str(mp3),
            "-f", "s16le",
            "-acodec", "pcm_s16le",
            "-ar", str(rate),
            "-ac", "1",
            "-",
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"❌ 解码音频失败 {mp3}: {result.stderr.decode('utf-8', 'replace')}")
    return result.stdout


def pcm_duration(pcm: bytes, rate: int = SAMPLE_RATE) -> float:
    return len(pcm) / 2 / rate


def write_wav(path: Path, pcm: bytes, rate: int = SAMPLE_RATE) -> Path:
    """把裸 PCM 写成 wav（44 字节头 + 数据），多屏拼成一条整集音轨。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        b"RIFF"
        + struct.pack("<I", 36 + len(pcm))
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
        + b"data"
        + struct.pack("<I", len(pcm))
    )
    path.write_bytes(header + pcm)
    return path


def _open_page(playwright, html: Path, width: int, height: int):
    browser = playwright.chromium.launch(executable_path=find_chromium())
    page = browser.new_page(
        viewport={"width": width, "height": height},
        device_scale_factor=1,
        reduced_motion="no-preference",
    )
    page.goto(html.resolve().as_uri(), wait_until="load")
    # 等字体与图片都到位，否则第一帧可能是回退字体/空白
    page.wait_for_function("Array.from(document.images).every((img) => img.complete)", timeout=15000)
    page.wait_for_timeout(250)
    return browser, page


def _scrub(page, seconds: float) -> None:
    page.evaluate(SCRUB_JS, seconds * 1000)


def capture_stills(
    html: Path,
    width: int,
    height: int,
    moments: list[tuple[str, float]],
    out_dir: Path,
) -> list[Path]:
    """在指定时刻各截一张静帧（抽帧验收 / 素材复用）。"""
    from playwright.sync_api import sync_playwright

    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    with sync_playwright() as playwright:
        browser, page = _open_page(playwright, html, width, height)
        try:
            for name, at in moments:
                _scrub(page, at)
                target = out_dir / f"{name}.png"
                page.screenshot(path=str(target), animations="allow")
                written.append(target)
        finally:
            browser.close()
    return written


def render_motion(
    html: Path,
    width: int,
    height: int,
    fps: int,
    duration: float,
    audio: Path,
    ass: Path,
    out_mp4: Path,
    limit: float | None = None,
) -> Path:
    """把一页动画 HTML 渲染成成片（画面 + 音轨 + 烧录字幕）。

    ``limit`` 只渲染前 N 秒，用于快速试片；成片时长由音轨决定（-shortest 兜底）。
    """
    from playwright.sync_api import sync_playwright

    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    total = duration if limit is None else min(duration, limit)
    frames = max(1, int(math.ceil(total * fps)))

    # ass 滤镜按 cwd 解析文件名，所以只传裸文件名并把 cwd 设到字幕目录
    cmd = [
        "ffmpeg", "-y", "-nostats", "-loglevel", "error",
        "-f", "image2pipe", "-framerate", str(fps), "-i", "-",
        "-i", str(audio.resolve()),
        "-vf", f"ass={ass.name}",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", str(fps),
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-shortest", "-movflags", "+faststart",
        str(out_mp4.resolve()),
    ]

    # ffmpeg 的 stderr 走临时文件而不是 PIPE：管道写满时 ffmpeg 会阻塞，
    # 而我们此时还在往它 stdin 灌帧，会直接死锁。
    with tempfile.TemporaryDirectory() as tmp:
        err_log = Path(tmp) / "ffmpeg.err"
        with sync_playwright() as playwright:
            browser = page = None

            def open_page():
                nonlocal browser, page
                browser, page = _open_page(playwright, html, width, height)

            open_page()
            with err_log.open("wb") as err_file:
                proc = subprocess.Popen(
                    cmd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=err_file,
                    cwd=str(ass.parent),
                )
                index = 0
                restarts = 0
                started = time.time()
                try:
                    while index < frames:
                        try:
                            _scrub(page, index / fps)
                            proc.stdin.write(page.screenshot(type="png", animations="allow"))
                            index += 1
                            if index % 150 == 0:
                                done = index / frames
                                print(f"   ⏳ {index}/{frames} 帧（{done:.0%}）· {time.time() - started:.0f}s")
                                sys.stdout.flush()
                        except PlaywrightError as exc:
                            # 浏览器中途崩了（TargetClosed）：页面是确定性的，
                            # 重开一个继续从当前帧接上；其它 playwright 错误直接抛。
                            if "TargetClosed" not in type(exc).__name__:
                                raise
                            restarts += 1
                            if restarts > 3:
                                raise SystemExit("❌ 浏览器连续崩溃超过 3 次，放弃渲染")
                            print(f"   ⚠️ 浏览器崩溃，重启后从第 {index} 帧继续")
                            _close_quietly(browser)
                            browser = page = None
                            open_page()
                finally:
                    try:
                        proc.stdin.close()
                    except BrokenPipeError:
                        pass
                    try:
                        code = proc.wait(timeout=180)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        code = proc.wait()
                    _close_quietly(browser)
            stderr = err_log.read_text("utf-8", "replace")
    if code != 0:
        raise SystemExit(f"❌ ffmpeg 编码失败:\n{stderr}")
    return out_mp4


def _close_quietly(browser) -> None:
    """关浏览器时不因为它已经崩了而抛异常。"""
    if browser is None:
        return
    try:
        browser.close()
    except Exception:
        pass
