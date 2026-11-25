#!/usr/bin/env python3
"""Regenerates platform icons and embedded artwork from the packaged icon.

assets/Icon.png is the artwork the installer, the store and the taskbar
show. Three files follow it:

  assets/Icon-windows.png  the same icon without Dock-style outer padding.
  assets/logo.png          the same artwork at 512 pixels, embedded as the app's
                           mark in the rail, the welcome page, the window and the
                           phone.
  assets/tray.png          the mark alone — the tile's white dropped — at 44
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

# The logo's colored TUI pixels have high saturation; the white tile and its
# neutral shadow do not, so they can be excluded from the tray glyph.
MARK_SATURATION = 40
# Electron's macOS/Linux icons keep 6.25% outside padding; Windows fills the
# canvas so the same mark does not look smaller than neighboring app icons.
ICON_CONTENT_RATIO = 0.875
WINDOW_ICON_SIDE = 1024
# Leave three output pixels around the mark so Lanczos ringing stays away
# from the tray image's corners.
TRAY_PADDING = 44
TRAY_SIDE = 44


def is_mark_pixel(pixel):
    r, g, b, a = pixel
    return bool(a and max(r, g, b) - min(r, g, b) > MARK_SATURATION)


def main():
    src = Image.open(os.path.join(ASSETS, "Icon.png")).convert("RGBA")
    width, height = src.size

    # The shared icon keeps outer padding for macOS/Linux; Windows uses the
    # same white rounded tile at full size, like Electron's Windows artwork.
    inset_x = round(width * (1 - ICON_CONTENT_RATIO) / 2)
    inset_y = round(height * (1 - ICON_CONTENT_RATIO) / 2)
    windows = src.crop((inset_x, inset_y, width - inset_x, height - inset_y))
    windows = windows.resize((WINDOW_ICON_SIDE, WINDOW_ICON_SIDE), Image.LANCZOS)
    windows.save(os.path.join(ASSETS, "Icon-windows.png"), optimize=True)
    print("assets/Icon-windows.png", windows.size)

    logo = src.resize((512, 512), Image.LANCZOS)
    logo.save(os.path.join(ASSETS, "logo.png"), optimize=True)
    print("assets/logo.png", logo.size)

    pixels = src.load()
    left, top, right, bottom = width, height, -1, -1
    for y in range(height):
        for x in range(width):
            if is_mark_pixel(pixels[x, y]):
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
            if is_mark_pixel(source[x, y]):
                target[x, y] = (0, 0, 0, 255)
    tray = mask.resize((TRAY_SIDE, TRAY_SIDE), Image.LANCZOS)
    tray.save(os.path.join(ASSETS, "tray.png"), optimize=True)
    print("assets/tray.png", tray.size)


main()
