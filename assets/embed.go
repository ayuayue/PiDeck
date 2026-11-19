// Package assets owns the artwork embedded by every target.
package assets

import (
	_ "embed"
)

// LogoPNG is the app's mark in the window, the rail, the welcome page and
// the phone: the same artwork the installer and the store icons show.
//
// logo.png is Icon.png — the packaged icon — at 512 pixels, so the app and
// its package cannot drift apart. Regenerate it with the icon's change:
//
//	python -c "from PIL import Image; Image.open('assets/Icon.png').convert('RGBA').resize((512, 512), Image.LANCZOS).save('assets/logo.png', optimize=True)"
//
//go:embed logo.png
var LogoPNG []byte
