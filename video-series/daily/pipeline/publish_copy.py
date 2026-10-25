#!/usr/bin/env python3
"""PiDeck AI 日更 · 发布文案生成：成片 → B 站 / 竖版 标题、简介、标签、动态。

用法：
  python publish_copy.py --script daily/scripts/2026-10-20.json
  python publish_copy.py --script daily/scripts/2026-10-20.json --copy daily/publish/2026-10-20.md
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline.daily_deck import DAILY, load_episode  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

# B 站标题上限 80 字符；抖音/小红书标题更短，取 30
BILI_TITLE_MAX = 80
VERTICAL_TITLE_MAX = 30


def clip(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def build_copy(episode: dict, series: dict) -> dict:
    title = episode.get("title", "")
    kind = episode.get("kind", "tip")
    kind_label = series.get("kindLabels", {}).get(kind, "技巧教程")
    ep_no = episode.get("episode")
    ep_tag = f"{series.get('seriesTag', 'PiDeck AI 日更')} 第 {ep_no} 期" if ep_no else series.get("seriesTag", "")
    hashtags = series.get("hashtags", [])
    links = series.get("links", {})
    disclaimer = series.get("disclaimer", "")

    pub = episode.get("publish", {})
    bili = pub.get("bilibili", {})
    vertical = pub.get("vertical", {})

    bili_title = clip(bili.get("title") or f"{title}｜{kind_label}", BILI_TITLE_MAX)
    bili_desc = bili.get("desc") or episode.get("desc", "")
    bili_tags = bili.get("tags") or hashtags
    dynamic = pub.get("dynamic", "")

    v_title = clip(vertical.get("title") or title, VERTICAL_TITLE_MAX)
    v_desc = vertical.get("desc") or bili_desc

    link_lines = []
    if links.get("github"):
        link_lines.append(f"源码与下载：{links['github']}")
    if links.get("releases"):
        link_lines.append(f"最新版本：{links['releases']}")
    if links.get("qq"):
        link_lines.append(f"交流群：{links['qq']}")

    def tag_str(tags: list[str]) -> str:
        return " ".join(f"#{t}" for t in tags)

    return {
        "epTag": ep_tag,
        "bilibili": {
            "title": bili_title,
            "desc": "\n".join(x for x in [bili_desc, "", *link_lines, "", disclaimer] if x is not None),
            "tags": bili_tags,
            "tagString": tag_str(bili_tags),
        },
        "vertical": {
            "title": v_title,
            "desc": "\n".join(x for x in [v_desc, "", *link_lines] if x is not None),
            "tagString": tag_str(bili_tags[:4]),
        },
        "dynamic": dynamic,
        "cover": pub.get("cover", {}),
    }


def render_markdown(episode: dict, copy: dict) -> str:
    b = copy["bilibili"]
    v = copy["vertical"]
    return f"""# {episode['date']} · {copy['epTag']}

## B 站

**标题**（{len(b['title'])}/80）
{b['title']}

**简介**
{b['desc']}

**标签**
{b['tagString']}

**动态**
{copy['dynamic'] or '（未提供）'}

## 竖版（抖音 / 小红书）

**标题**（{len(v['title'])}/30）
{v['title']}

**简介**
{v['desc']}

**标签**
{v['tagString']}
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="生成发布文案")
    parser.add_argument("--script", required=True, help="scripts/YYYY-MM-DD.json")
    parser.add_argument("--series", default="", help="config/series.json")
    parser.add_argument("--copy", default="", help="输出 markdown 路径")
    args = parser.parse_args()

    script = Path(args.script)
    if not script.is_absolute():
        script = (Path.cwd() / script).resolve()
    episode = load_episode(script)

    series_path = Path(args.series) if args.series else DAILY / "config" / "series.json"
    if not series_path.is_absolute():
        series_path = (Path.cwd() / series_path).resolve()
    series = json.loads(series_path.read_text(encoding="utf-8"))

    copy = build_copy(episode, series)
    md = render_markdown(episode, copy)

    out = Path(args.copy) if args.copy else DAILY / "publish" / f"{episode['date']}.md"
    if not out.is_absolute():
        out = (Path.cwd() / out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md, encoding="utf-8")
    print(md)
    print(f"✅ 已写出 {out}")


if __name__ == "__main__":
    main()
