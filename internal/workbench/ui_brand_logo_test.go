//go:build !js && !android && !ios

package workbench

// The two built-in logo presets must look different. They stopped being
// different when the packaged icon became the colored artwork: the classic
// preset read the same bytes, so both choices drew one picture.

import (
	"testing"

	"github.com/nsgo-dev/nsgo/core"
)

// TestLogoSortedStylesAreDistinct checks each built-in preset draws its own
// mark, so the settings offer a real choice.
func TestLogoStylesAreDistinct(t *testing.T) {
	tui := svgOf(t, logoMark(logoStyleTUI, brandImage{}, 30, ""))
	classic := svgOf(t, logoMark(logoStyleClassic, brandImage{}, 30, ""))
	if tui == nil || classic == nil {
		t.Fatal("a preset draws no vector mark")
	}
	if tui == classic {
		t.Fatal("the two presets share one mark: the classic preset is not the packaged icon")
	}
}

// TestLogoClassicIsDark checks the classic preset uses the dark mark required
// for contrast on the shared white tile.
func TestLogoClassicIsDark(t *testing.T) {
	classic := svgOf(t, logoMark(logoStyleClassic, brandImage{}, 30, ""))
	if classic == nil {
		t.Fatal("the classic preset draws no vector mark")
	}
	if classic == piTUILogo {
		t.Fatal("the classic preset is the TUI colors")
	}
	if classic != piClassicLogo {
		t.Fatal("the classic preset is not the dark mark")
	}
}

func TestLogoMarksUseWhiteTileAnd65PercentGlyph(t *testing.T) {
	const size core.Points = 40
	for _, style := range []string{logoStyleTUI, logoStyleClassic} {
		view, ok := logoMark(style, brandImage{}, size, "").(core.View)
		if !ok {
			t.Fatalf("style %q did not render a tile", style)
		}
		if view.Style.Background != core.RGB(0xffffff) {
			t.Errorf("style %q background = %v, want white", style, view.Style.Background)
		}
		if view.Style.CornerRadius != size*228/1024 {
			t.Errorf("style %q corner radius = %v, want %v", style, view.Style.CornerRadius, size*228/1024)
		}
		if len(view.Children) != 1 {
			t.Fatalf("style %q has %d children, want one mark", style, len(view.Children))
		}
		mark, ok := view.Children[0].(core.SVGView)
		if !ok {
			t.Fatalf("style %q child = %T, want SVGView", style, view.Children[0])
		}
		wantGlyph := core.Pt(size * 0.65)
		if mark.Style.Width != wantGlyph || mark.Style.Height != wantGlyph {
			t.Errorf("style %q glyph = %v x %v, want %v square", style, mark.Style.Width, mark.Style.Height, wantGlyph)
		}
	}
}

// svgOf is the SVG a logo mark draws, or nil when it draws none.
func svgOf(t *testing.T, node core.Node) *core.SVG {
	t.Helper()
	var find func(core.Node, int) *core.SVG
	find = func(n core.Node, depth int) *core.SVG {
		if depth > 3 {
			return nil
		}
		switch v := n.(type) {
		case core.SVGView:
			return v.SVG
		case core.View:
			for _, child := range v.Children {
				if svg := find(child, depth+1); svg != nil {
					return svg
				}
			}
		}
		return nil
	}
	return find(node, 0)
}
