package viewkit

// A review row's glyphs, drawn the same by the workbench's pane and the
// phone's: what kind of item it is, whether it merged or closed, and how its
// checks ended. The hosts keep the item types they own, so only the states —
// the wire's own words — come through here.

import (
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// The states an item and its checks report.
const (
	ReviewMerged = "MERGED"
	ReviewClosed = "CLOSED"
	CheckPass    = "pass"
	CheckFail    = "fail"
	CheckPending = "pending"
)

// ReviewGlyph is an item's kind and state in one glyph: merged, closed, or
// the kind itself while it is open.
func ReviewGlyph(state string, pr bool) func() *core.SVG {
	switch state {
	case ReviewMerged:
		return lucide.GitMerge
	case ReviewClosed:
		if pr {
			return lucide.GitPullRequestClosed
		}
		return lucide.CircleSlash
	}
	if pr {
		return lucide.GitPullRequestArrow
	}
	return lucide.CircleDot
}

// ReviewGlyphColor colors it: a merge takes the accent, a close fades, a
// failing check warns, and anything still open reads as going well.
func ReviewGlyphColor(colors ui.Colors, state string, failing bool) core.Color {
	switch state {
	case ReviewMerged:
		return colors.Accent()
	case ReviewClosed:
		return colors.Faint()
	}
	if failing {
		return colors.Danger()
	}
	return colors.Up()
}

// ReviewCheckGlyph is one check's glyph. A state this build does not know —
// a host that answers with a newer one — keeps the clock, which says the
// check has not settled rather than leaving the row blank.
func ReviewCheckGlyph(state string) func() *core.SVG {
	switch state {
	case CheckPass:
		return lucide.CircleCheck
	case CheckFail:
		return lucide.CircleX
	}
	return lucide.Clock
}
