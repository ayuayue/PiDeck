// Package assets owns the artwork embedded by every target.
package assets

import (
	_ "embed"
)

// LogoPNG is the app's mark in the window, the rail, the welcome page and
// the phone: the same artwork the installer and the store icons show.
//
// logo.png is Icon.png — the packaged icon — at 512 pixels, so the app and
// its package cannot drift apart. Both it and tray.png follow the icon
// through scripts/icons.py; run that when the artwork changes.
//
//go:embed logo.png
var LogoPNG []byte

// TrayGlyphPNG is the same mark without its tile, for a menu bar that
// draws its own icons in its own colors: macOS reads the alpha as the
// shape, so a template image is the glyph alone, never the rounded square.
// It is 44 pixels, two for each of the menu bar's 22.
//
//go:embed tray.png
var TrayGlyphPNG []byte
