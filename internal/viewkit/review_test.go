package viewkit

// The review glyphs both hosts draw: every state reads, and a state this
// build does not know still gets a glyph instead of a blank row.

import (
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
)

// TestReviewGlyph guards the items' glyphs: merged and closed say so, an open
// one keeps its kind, and the unknown state is still a pull request or an
// issue.
func TestReviewGlyph(t *testing.T) {
	for _, c := range []struct {
		state string
		pr    bool
		want  func() *core.SVG
	}{
		{ReviewMerged, true, lucide.GitMerge},
		{ReviewClosed, true, lucide.GitPullRequestClosed},
		{ReviewClosed, false, lucide.CircleSlash},
		{"OPEN", true, lucide.GitPullRequestArrow},
		{"OPEN", false, lucide.CircleDot},
	} {
		got := ReviewGlyph(c.state, c.pr)()
		if got == nil {
			t.Fatalf("ReviewGlyph(%q, pr=%v) is nothing; want a glyph", c.state, c.pr)
		}
		if got != c.want() {
			t.Errorf("ReviewGlyph(%q, pr=%v) is not the mark of its state", c.state, c.pr)
		}
	}
}

// TestReviewCheckGlyph guards the checks' glyphs: pass and fail say so, and a
// state this build does not know keeps the clock rather than nothing.
func TestReviewCheckGlyph(t *testing.T) {
	for state, want := range map[string]func() *core.SVG{
		CheckPass:    lucide.CircleCheck,
		CheckFail:    lucide.CircleX,
		CheckPending: lucide.Clock,
		"queued":     lucide.Clock,
	} {
		got := ReviewCheckGlyph(state)()
		if got == nil {
			t.Fatalf("ReviewCheckGlyph(%q) is nothing; want a glyph", state)
		}
		if got != want() {
			t.Errorf("ReviewCheckGlyph(%q) is not the mark of its state", state)
		}
	}
}
