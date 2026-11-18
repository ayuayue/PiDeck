// Package assets owns the artwork embedded by every target.
package assets

import (
	_ "embed"
)

// LogoPNG is PiDeck's classic logo and tray icon.
//
//go:embed logo.png
var LogoPNG []byte
