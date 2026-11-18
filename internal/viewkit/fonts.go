package viewkit

// Text sizes shared by every build: the transcript's reading size and line
// height, and the composer's size. Config values of 0 keep the defaults.

import (
	"github.com/nsgo-dev/nsgo/core"
)

const (
	// chatFontMin and chatFontMax bound the reading size in points.
	ChatFontMin = 11.0
	ChatFontMax = 20.0
	// chatFontDefault is the transcript's size until the user picks one:
	// 15 points, close to PiDeck's 16 with this app's narrower column.
	ChatFontDefault = 15.0
	// chatLineMin and chatLineMax bound the line height, as a multiple of
	// the reading size; chatLineDefault is PiDeck's 1.6 (24 points at the
	// default size).
	ChatLineMin     = 1.3
	ChatLineMax     = 2.2
	ChatLineDefault = 1.6
	// inputFontDefault is the composer's size until the user picks one.
	InputFontDefault = 15.0
)

// monoFamily is the family monospaced text is drawn in: the one the user
// named, else the theme's, else the platform's. It is set as the theme is
// applied, so a family change reaches every built view on the next pass.
var MonoFamily = core.FontMonospace

// monoFont is monoFamily, for a style's FontFamily.
func MonoFont() string { return MonoFamily }
