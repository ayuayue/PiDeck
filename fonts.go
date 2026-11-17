package main

// Text sizes shared by every build: the transcript's reading size and line
// height, and the composer's size. Config values of 0 keep the defaults.

import "github.com/nsgo-dev/nsgo/core"

const (
	// chatFontMin and chatFontMax bound the reading size in points.
	chatFontMin = 11.0
	chatFontMax = 20.0
	// chatFontDefault is the transcript's size until the user picks one.
	chatFontDefault = 13.5
	// chatLineMin and chatLineMax bound the line height, as a multiple of
	// the reading size; chatLineDefault is 22 points at the default size.
	chatLineMin     = 1.3
	chatLineMax     = 2.2
	chatLineDefault = 1.63
	// inputFontDefault is the composer's size until the user picks one.
	inputFontDefault = 13.5
)

// monoFamily is the family monospaced text is drawn in: the one the user
// named, else the theme's, else the platform's. It is set as the theme is
// applied, so a family change reaches every built view on the next pass.
var monoFamily = core.FontMonospace

// monoFont is monoFamily, for a style's FontFamily.
func monoFont() string { return monoFamily }
