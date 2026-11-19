#!/usr/bin/env python3
"""Regenerates the app's two derived images from the packaged icon.

assets/Icon.png is the artwork the installer, the store and the taskbar
show. Two files follow it:

  assets/logo.png  the same artwork at 512 pixels, embedded as the app's
                   mark in the rail, the welcome page, the window and the
                   phone.
  assets/tray.png  the mark alone — the tile's black dropped — at 44
                   pixels, two for each of the menu bar's 22, because a
                   template image is a shape macOS paints in its own
                   colors.

Run after changing Icon.png:   python scripts/icons.py
Needs Pillow.
"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("needs Pillow:  pip install pillow")

ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")

# The tile behind the mark is near-black; the mark's colors are the only
# bright pixels, so a brightness threshold separates one from the other.
MARK_BRIGHTNESS = 90
# Space kept around the mark in a tray image, in icon pixels.
TRAY_PADDING = 22
TRAY_SIDE = 44


def main():
    src = Image.open(os.path.join(ASSETS, "Icon.png")).convert("RGBA")

    logo = src.resize((512, 512), Image.LANCZOS)
    logo.save(os.path.join(ASSETS, "logo.png"), optimize=True)
    print("assets/logo.png", logo.size)

    width, height = src.size
    pixels = src.load()
    left, top, right, bottom = width, height, -1, -1
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a and max(r, g, b) > MARK_BRIGHTNESS:
                left, top = min(left, x), min(top, y)
                right, bottom = max(right, x), max(bottom, y)
    if right < 0:
        sys.exit("Icon.png has no mark to cut")

    crop = src.crop((max(0, left - TRAY_PADDING), max(0, top - TRAY_PADDING),
                     min(width, right + 1 + TRAY_PADDING), min(height, bottom + 1 + TRAY_PADDING)))
    side = max(crop.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(crop, ((side - crop.size[0]) // 2, (side - crop.size[1]) // 2))

    mask = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    source, target = canvas.load(), mask.load()
    for y in range(side):
        for x in range(side):
            r, g, b, a = source[x, y]
            if a and max(r, g, b) > MARK_BRIGHTNESS // 2 + 15:
                target[x, y] = (0, 0, 0, 255)
    tray = mask.resize((TRAY_SIDE, TRAY_SIDE), Image.LANCZOS)
    tray.save(os.path.join(ASSETS, "tray.png"), optimize=True)
    print("assets/tray.png", tray.size)


main()
