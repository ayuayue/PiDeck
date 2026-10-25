#!/usr/bin/env bash
# shot.sh <name> [crop x,y,w,h] - capture the PiDeck main window at its pinned 16:9 rect
# and optionally crop it, so status checks cost one small image instead of a full frame.
#   ./tools/shot.sh idle
#   ./tools/shot.sh composer 435,870,980,160
set -e
cd "$(dirname "$0")/.."
HWND=${PIDECK_HWND:-1708894}
NAME=$1
CROP=${2:-}
powershell -NoProfile -File tools/win_shot.ps1 -Out "ref/$NAME.png" -Hwnd "$HWND" >/dev/null
if [ -n "$CROP" ]; then
  python - "$NAME" "$CROP" <<'PY'
import sys
from PIL import Image
name, crop = sys.argv[1], sys.argv[2]
x, y, w, h = [int(v) for v in crop.split(",")]
im = Image.open("ref/%s.png" % name).convert("RGB")
im.crop((x, y, x + w, y + h)).save("ref/%s.png" % name)
print("ref/%s.png %dx%d" % (name, w, h))
PY
else
  python -c "from PIL import Image;print('ref/$NAME.png',Image.open('ref/$NAME.png').size)"
fi
