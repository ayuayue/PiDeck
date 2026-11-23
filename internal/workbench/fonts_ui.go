//go:build !js && !android && !ios

package workbench

// The reading and writing sizes the appearance settings pick: the
// transcript's text and line height, and the composer's text.

import (
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
)

// readingFont is the transcript's text size.
func (a *app) readingFont() core.Points {
	if v := a.chatFont.Get(); v >= viewkit.ChatFontMin && v <= viewkit.ChatFontMax {
		return core.Points(v)
	}
	return viewkit.ChatFontDefault
}

// readingRatio is the transcript's line height as a multiple of its size.
func (a *app) readingRatio() float64 {
	if v := a.chatLine.Get(); v >= viewkit.ChatLineMin && v <= viewkit.ChatLineMax {
		return v
	}
	return viewkit.ChatLineDefault
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
	if v := a.inputFont.Get(); v >= viewkit.ChatFontMin && v <= viewkit.ChatFontMax {
		return core.Points(v)
	}
	return a.readingFont()
}

// composerLine is a line in the composer, 1.48 of its text size, as the
// kit's composer had 20 points at 13.5.
func (a *app) composerLine() core.Points {
	return core.Points(float64(a.composerFont()) * 1.48)
}

// The process layer is derived from the reading size, as in PiDeck: rows
// and details stay two and four points behind the prose, with a floor so a
// small setting keeps them readable, and a line height that stays legible.
func (a *app) readingRowFont() core.Points {
	return readingRowSize(a.readingFont())
}

// readingRowSize follows PiDeck's process scale. A large reading setting
// must also enlarge the process text, which carries essential information.
func readingRowSize(chat core.Points) core.Points {
	return max(core.Points(13), chat-2)
}

// readingRowLine is a process row's line height.
func (a *app) readingRowLine() core.Points {
	return core.Points(float64(a.readingRowFont()) * 1.54)
}

// readingDetailFont is the size of previews, durations and mono details.
func (a *app) readingDetailFont() core.Points {
	return readingDetailSize(a.readingFont())
}

// readingDetailSize is readingDetailFont's rule: four points under the
// prose, with a readable floor and no upper cap.
func readingDetailSize(chat core.Points) core.Points {
	return max(core.Points(12), chat-4)
}

// readingDetailLine is a detail's line height.
func (a *app) readingDetailLine() core.Points {
	return core.Points(float64(a.readingDetailFont()) * 1.5)
}

// setChatFont stores the transcript's text size and redraws the app with
// it: the root reads the signal, so every prose rebuilds at the new size.
func (a *app) setChatFont(v float64) {
	if v < viewkit.ChatFontMin || v > viewkit.ChatFontMax {
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
	if v < viewkit.ChatLineMin || v > viewkit.ChatLineMax {
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
	if v != 0 && (v < viewkit.ChatFontMin || v > viewkit.ChatFontMax) {
		return
	}
	a.cfg.InputFont = v
	a.inputFont.Set(v)
	if a.st != nil {
		a.st.edit(func(c *config) { c.InputFont = v })
	}
}
