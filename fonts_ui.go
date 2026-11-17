//go:build !js && !android && !ios

package main

// The reading and writing sizes the appearance settings pick: the
// transcript's text and line height, and the composer's text.

import "github.com/nsgo-dev/nsgo/core"

// readingFont is the transcript's text size.
func (a *app) readingFont() core.Points {
	if v := a.chatFont.Get(); v >= chatFontMin && v <= chatFontMax {
		return core.Points(v)
	}
	return chatFontDefault
}

// readingRatio is the transcript's line height as a multiple of its size.
func (a *app) readingRatio() float64 {
	if v := a.chatLine.Get(); v >= chatLineMin && v <= chatLineMax {
		return v
	}
	return chatLineDefault
}

// readingLine is the transcript's line height in points.
func (a *app) readingLine() core.Points {
	return core.Points(float64(a.readingFont()) * a.readingRatio())
}

// readingStyle is the transcript's paragraph style.
func (a *app) readingStyle() core.Style {
	return core.Style{FontSize: a.readingFont(), LineHeight: a.readingLine()}
}

// composerFont is the composer's text size: its own, else the reading
// size.
func (a *app) composerFont() core.Points {
	if v := a.inputFont.Get(); v >= chatFontMin && v <= chatFontMax {
		return core.Points(v)
	}
	return a.readingFont()
}

// composerLine is a line in the composer, 1.48 of its text size, as the
// kit's composer had 20 points at 13.5.
func (a *app) composerLine() core.Points {
	return core.Points(float64(a.composerFont()) * 1.48)
}

// setChatFont stores the transcript's text size and redraws the app with
// it: the root reads the signal, so every prose rebuilds at the new size.
func (a *app) setChatFont(v float64) {
	if v < chatFontMin || v > chatFontMax {
		return
	}
	a.cfg.ChatFont = v
	a.chatFont.Set(v)
	if a.st != nil {
		a.st.edit(func(c *config) { c.ChatFont = v })
	}
}

// setChatLine stores the transcript's line height multiple.
func (a *app) setChatLine(v float64) {
	if v < chatLineMin || v > chatLineMax {
		return
	}
	a.cfg.ChatLine = v
	a.chatLine.Set(v)
	if a.st != nil {
		a.st.edit(func(c *config) { c.ChatLine = v })
	}
}

// setInputFont stores the composer's text size; 0 follows the reading size.
func (a *app) setInputFont(v float64) {
	if v != 0 && (v < chatFontMin || v > chatFontMax) {
		return
	}
	a.cfg.InputFont = v
	a.inputFont.Set(v)
	if a.st != nil {
		a.st.edit(func(c *config) { c.InputFont = v })
	}
}
