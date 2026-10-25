#!/usr/bin/env python3
"""PiDeck AI 日更 · HTML 拼装。

产出一页「整集」HTML：所有屏叠在同一个 `.stage` 里，每屏一个绝对定位图层，
靠 `--in`（入场时刻）/ `--out`（退场时刻）两个 CSS 变量驱动交叉溶解。

为什么不再一页一屏地截静帧：那样做出来的成片是幻灯片播放，没有进出场、没有
交叉溶解，节奏是死的。整集单页才能让相邻两屏在同一时刻互相溶解。
"""
from __future__ import annotations

import html
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.timeline import TRANSITION, LayerWindow, SlideTiming, layer_windows  # noqa: E402
from templates.deck_css import FORMATS  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

DAILY = Path(__file__).resolve().parent.parent
REPO_ROOT = DAILY.parent.parent


def esc(text: str) -> str:
    return html.escape(str(text), quote=True)


def img_uri(raw: str) -> str:
    """仓库相对路径 → file:// URI。"""
    path = Path(raw)
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path.resolve().as_uri()


def crop_box(crop: dict, size: tuple[int, int]) -> tuple[int, int, int, int]:
    """0..1 比例裁剪框 → 像素框。"""
    width, height = size
    x = max(0.0, min(1.0, float(crop.get("x", 0.0))))
    y = max(0.0, min(1.0, float(crop.get("y", 0.0))))
    w = max(0.0, min(1.0 - x, float(crop.get("w", 1.0))))
    h = max(0.0, min(1.0 - y, float(crop.get("h", 1.0))))
    return int(x * width), int(y * height), int(w * width), int(h * height)


def prepare_image(src: str, crop: dict | None, out_path: Path) -> str:
    """按画幅裁剪产品截图，产物落 out/assets/<fmt>/<slide-id>.png。"""
    source = Path(src)
    if not source.is_absolute():
        source = REPO_ROOT / source
    if not crop:
        return img_uri(src)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image
    except ImportError:
        print(f"⚠️ 未安装 Pillow，跳过裁剪: {src}")
        return img_uri(src)
    try:
        with Image.open(source) as img:
            img = img.convert("RGB")
            if crop.get("w", 1.0) >= 0.999 and crop.get("h", 1.0) >= 0.999:
                box = (0, 0, img.width, img.height)
            else:
                # crop_box 返回的是 (x, y, w, h) 像素，PIL.crop 要的是 (left, top, right, bottom)
                x, y, w, h = crop_box(crop, (img.width, img.height))
                box = (x, y, x + w, y + h)
            img.crop(box).save(out_path)
    except Exception as exc:  # noqa: BLE001 - 截图缺失不该让整集渲染失败
        print(f"⚠️ 裁剪失败 {src}: {exc}")
        return img_uri(src)
    return out_path.resolve().as_uri()


def _d(value: float) -> str:
    return f"{value:.2f}s"


def _head(title: str, delay: float, with_rule: bool = True) -> str:
    """标题 + 强调色短线（wipe 入场）。"""
    if not title:
        return ""
    html_out = f'<h2 class="rise" style="--d:{_d(delay)};margin-bottom:0">{esc(title)}</h2>'
    if with_rule:
        html_out += f'<div class="rule" style="--d:{_d(delay + 0.1)};margin:20px 0 34px"></div>'
    return html_out


def slide_body(slide: dict, fmt: str = "16x9", image: str | None = None) -> str:
    """一屏的正文 HTML（带入场动效类与错峰延时）。"""
    kind = slide.get("type", "bullets")
    title = slide.get("title", "")
    lead = slide.get("lead", "")
    caption = slide.get("caption", "")
    bullets = slide.get("bullets", []) or []

    if kind == "cover":
        parts = []
        if slide.get("kicker"):
            parts.append(f'<div class="kicker rise" style="--d:{_d(0.0)}">{esc(slide["kicker"])}</div>')
        if title:
            parts.append(f'<h1 class="rise" style="--d:{_d(0.08)}">{esc(title)}</h1>')
        if lead:
            parts.append(f'<p class="lead rise-soft" style="--d:{_d(0.24)};margin-top:30px">{esc(lead)}</p>')
        return "".join(parts)

    if kind == "hook":
        parts = []
        if slide.get("kicker"):
            parts.append(f'<div class="kicker rise" style="--d:{_d(0.0)}">{esc(slide["kicker"])}</div>')
        if title:
            parts.append(f'<h1 class="rise" style="--d:{_d(0.08)};margin-bottom:0">{esc(title)}</h1>')
            parts.append(f'<div class="rule" style="--d:{_d(0.18)};margin:22px 0 0"></div>')
        if lead:
            parts.append(f'<p class="lead rise-soft" style="--d:{_d(0.26)};margin-top:30px">{esc(lead)}</p>')
        return "".join(parts)

    if kind in ("bullets", "steps"):
        tag = "ol" if kind == "steps" else "ul"
        cls = "steps" if kind == "steps" else "bullets"
        items = []
        for index, item in enumerate(bullets):
            base = 0.20 + index * 0.1
            items.append(
                f'<li class="rise-soft" style="--d:{_d(base)}">'
                f'<span class="n pop" style="--d:{_d(base + 0.06)}">{index + 1}</span>'
                f'<span>{esc(item)}</span></li>'
            )
        return _head(title, 0.02) + f'<{tag} class="{cls}">' + "".join(items) + f"</{tag}>"

    if kind == "shot":
        img_tag = f'<img src="{image}" alt="">' if image else ""
        if fmt == "3x4":
            return (
                f'<div class="shot shot-v"><div class="shot-img reveal" style="--d:{_d(0.02)}">{img_tag}</div></div>'
                f'<h2 class="rise" style="--d:{_d(0.16)};margin:32px 0 0">{esc(title)}</h2>'
                f'<div class="rule" style="--d:{_d(0.24)};margin:18px 0 0"></div>'
                f'<p class="shot-cap rise-soft" style="--d:{_d(0.30)};margin-top:22px">{esc(caption)}</p>'
            )
        return (
            f'<div class="shot-2col">'
            f'<div class="shot-copy">'
            f'<h2 class="rise" style="--d:{_d(0.02)};margin-bottom:0">{esc(title)}</h2>'
            f'<div class="rule" style="--d:{_d(0.10)};margin:20px 0 22px"></div>'
            f'<p class="shot-cap rise-soft" style="--d:{_d(0.20)}">{esc(caption)}</p>'
            f'</div>'
            f'<div class="shot-img reveal" style="--d:{_d(0.06)}">{img_tag}</div>'
            f'</div>'
        )

    if kind == "quote":
        body = f'<div class="quote rise" style="--d:{_d(0.02)}">{esc(slide.get("text", title))}</div>'
        if lead:
            body += f'<p class="lead rise-soft" style="--d:{_d(0.20)};margin-top:30px">{esc(lead)}</p>'
        return body

    if kind == "cta":
        parts = []
        if title:
            parts.append(f'<h1 class="rise" style="--d:{_d(0.02)};font-size:var(--fs-h2);margin-bottom:0">{esc(title)}</h1>')
            parts.append(f'<div class="rule" style="--d:{_d(0.12)};margin:20px 0 0"></div>')
        if lead:
            parts.append(f'<p class="lead rise-soft" style="--d:{_d(0.20)};margin-top:28px">{esc(lead)}</p>')
        if bullets:
            chips = "".join(
                f'<span class="chip pop" style="--d:{_d(0.30 + index * 0.09)}">{esc(item)}</span>'
                for index, item in enumerate(bullets)
            )
            parts.append(f'<div class="cta-row" style="margin-top:36px">{chips}</div>')
        return "".join(parts)

    return f'<h2 class="rise" style="--d:{_d(0.02)}">{esc(title)}</h2>'


def _chrome(episode: dict) -> str:
    """固定 chrome：品牌条 + 页脚。"""
    return (
        '<div class="mast">'
        f'<div class="brand"><span class="brand-mark"></span>{esc(episode.get("brand", "PiDeck"))}</div>'
        f'<div class="ep-tag">{esc(episode.get("epTag", ""))}</div>'
        '</div>'
    )


def _foot(episode: dict) -> str:
    return (
        '<div class="foot">'
        f'<span>{esc(episode.get("slogan", ""))}</span>'
        f'<span>{esc(episode.get("footRight", ""))}</span>'
        '</div>'
    )


def render_episode(
    episode: dict,
    fmt: str,
    windows: list[LayerWindow],
    total: float,
    assets: dict[str, str],
) -> str:
    """整集单页 HTML。"""
    spec = FORMATS[fmt]
    layers: list[str] = []
    for slide, window in zip(episode["slides"], windows):
        body = slide_body(slide, fmt, assets.get(slide["id"]))
        align = ' style="justify-content:center;"'
        # 带整屏截图的页要腾出底部字幕安全区，否则烧录字幕会压住画面
        extra = " has-img" if slide.get("type") == "shot" else ""
        layers.append(
            f'<div class="layer{extra}" style="--in:{window.enter_at:.3f}s;--out:{window.exit_at:.3f}s;">'
            f'<div class="layer-in"{align}>{body}</div></div>'
        )
    return (
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        f"<style>{spec['css']}</style></head><body>"
        f'<div class="slide deck" style="--total:{total:.3f}s;--trans:{TRANSITION}s;">'
        '<div class="deck-bg"></div>'
        f"{_chrome(episode)}"
        f'<div class="stage">{"".join(layers)}</div>'
        f"{_foot(episode)}"
        '<div class="progress"><i></i></div>'
        '<div class="deck-fade"></div>'
        "</div></body></html>"
    )


def render_single(episode: dict, slide: dict, fmt: str, image: str | None) -> str:
    """单屏静态预览页（动效停在终态，方便在浏览器里调版式）。"""
    spec = FORMATS[fmt]
    body = slide_body(slide, fmt, image)
    align = ' style="justify-content:center;"'
    return (
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        f"<style>{spec['css']}</style></head><body>"
        f'<div class="slide deck static" style="--total:10s;--trans:{TRANSITION}s;">'
        '<div class="deck-bg"></div>'
        f"{_chrome(episode)}"
        f'<div class="stage"><div class="layer" style="--in:0s;--out:9999s;"><div class="layer-in"{align}>{body}</div></div></div>'
        f"{_foot(episode)}"
        '<div class="progress"><i></i></div>'
        "</div></body></html>"
    )


def build(episode: dict, out_dir: Path, timings: list[SlideTiming]) -> dict[str, Path]:
    """写出整集 HTML + 单屏预览 HTML + 裁剪后的截图素材。"""
    out_dir = Path(out_dir)
    windows = layer_windows(timings)
    total = sum(t.duration for t in timings)
    written: dict[str, Path] = {}

    for fmt in episode.get("formats", ["16x9", "3x4"]):
        assets: dict[str, str] = {}
        for slide in episode["slides"]:
            if slide.get("image"):
                crop = slide.get("crop") if fmt == "16x9" else (slide.get("crop3x4") or slide.get("crop"))
                assets[slide["id"]] = prepare_image(
                    slide["image"], crop, out_dir / "assets" / fmt / f"{slide['id']}.png"
                )

        html_dir = out_dir / "html" / fmt
        html_dir.mkdir(parents=True, exist_ok=True)
        episode_html = html_dir / "episode.html"
        episode_html.write_text(render_episode(episode, fmt, windows, total, assets), encoding="utf-8")
        written[fmt] = episode_html

        for slide in episode["slides"]:
            single = html_dir / f"{slide['id']}.html"
            single.write_text(render_single(episode, slide, fmt, assets.get(slide["id"])), encoding="utf-8")
    return written


def load_episode(path: Path) -> dict:
    episode = json.loads(Path(path).read_text(encoding="utf-8"))
    slides = episode.get("slides") or []
    if not slides:
        raise SystemExit("❌ 脚本里没有 slides")
    for index, slide in enumerate(slides):
        if not str(slide.get("narration", "")).strip():
            raise SystemExit(f"❌ slide {slide.get('id', index)} 缺 narration")
        if not slide.get("id"):
            slide["id"] = f"{index + 1:02d}-{slide.get('type', 'slide')}"
    return episode


def main() -> None:
    import argparse

    from pipeline.timeline import build_timeline, estimate_durations

    parser = argparse.ArgumentParser(description="把日更脚本拼成 HTML")
    parser.add_argument("--script", required=True)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    script_path = Path(args.script)
    episode = load_episode(script_path)
    date = episode.get("date", script_path.stem)
    out_dir = Path(args.out) if args.out else DAILY / "out" / date
    timings = build_timeline(estimate_durations(episode["slides"]))
    written = build(episode, out_dir, timings)
    for fmt, path in written.items():
        print(f"✅ {fmt}: {path}")


if __name__ == "__main__":
    main()
