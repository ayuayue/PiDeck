#!/usr/bin/env python3
"""按时刻从整集单页 HTML 抽帧，用来快速验收动效（不用重渲整集）。

用法：
  python video-series/daily/probe_motion.py                     # 默认日期/画幅/时刻
  python video-series/daily/probe_motion.py 2026-10-20 3x4 1.5 9
  python video-series/daily/probe_motion.py --date 2026-10-20 --format 16x9 --times 0.2,1.5,7.5

产物：daily/out/<date>/probe_<format>/t<毫秒>.png
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

DAILY = Path(__file__).resolve().parent
sys.path.insert(0, str(DAILY))

from pipeline.render_motion import capture_stills  # noqa: E402
from templates.deck_css import FORMATS  # noqa: E402

DEFAULT_TIMES = [0.05, 0.6, 1.5, 7.5, 9.0, 20.0, 30.0, 54.0]


def main() -> None:
    parser = argparse.ArgumentParser(description="抽帧验收动效")
    parser.add_argument("--date", default="2026-10-20", help="已渲染的日期目录")
    parser.add_argument("--format", default="16x9", choices=sorted(FORMATS), help="画幅")
    parser.add_argument("--times", default="", help="逗号分隔的时刻（秒），缺省用一组默认点")
    args = parser.parse_args()

    times = [float(t) for t in args.times.split(",") if t.strip()] or DEFAULT_TIMES
    html = DAILY / "out" / args.date / "html" / args.format / "episode.html"
    if not html.exists():
        raise SystemExit(f"❌ 找不到 {html}，先跑一次 daily_deck.py 出 HTML")

    spec = FORMATS[args.format]
    out_dir = DAILY / "out" / args.date / f"probe_{args.format}"
    moments = [(f"t{int(t * 100):05d}", t) for t in times]
    for path in capture_stills(html, spec["width"], spec["height"], moments, out_dir):
        print(path)


if __name__ == "__main__":
    main()
