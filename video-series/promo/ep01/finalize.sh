#!/usr/bin/env bash
# v2 成片封装：120fps 源 → tmix 运动模糊 → 60fps → 混入 audio.wav
# 用法：./finalize.sh   （前提：film.mp4 与 audio.wav 已存在）
set -euo pipefail
cd "$(dirname "$0")"

IN=film.mp4
MID=film-60.mp4
OUT=promo-ep01-final.mp4

[ -f "$IN" ]  || { echo "missing $IN — 先跑 render-video-seek.js"; exit 1; }
[ -f audio.wav ] || { echo "missing audio.wav — 先跑 python mix-audio.py"; exit 1; }

# tmix=frames=2 把相邻 2 帧（120fps → 8.3ms 窗口）做时间平均，得到轻微运动模糊。
# 权重 1 1 是等权；别用更大的 frames 数（120fps 下 4 帧 = 33ms，UI 会拖成鬼影）。
echo "▸ 运动模糊 + 降帧 120 → 60"
ffmpeg -y -hide_banner -loglevel error -i "$IN" \
  -vf "tmix=frames=2:weights='1 1',format=yuv420p" \
  -r 60 -c:v libx264 -crf 16 -preset slow -movflags +faststart "$MID"

echo "▸ 混入混音轨"
ffmpeg -y -hide_banner -loglevel error -i "$MID" -i audio.wav \
  -map 0:v:0 -map 1:a:0 \
  -c:v copy -c:a aac -b:a 192k -ar 48000 -shortest \
  -movflags +faststart "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo "✓ $OUT  ($SIZE)"
ffprobe -v error -show_entries format=duration -show_entries stream=codec_name,width,height,r_frame_rate \
  -of default=nw=1 "$OUT"
