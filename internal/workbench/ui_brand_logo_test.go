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

// TestLogoClassicIsSilver checks the classic preset is the monochrome mark,
// not the colored one in a different tile.
func TestLogoClassicIsSilver(t *testing.T) {
	classic := svgOf(t, logoMark(logoStyleClassic, brandImage{}, 30, ""))
	if classic == nil {
		t.Fatal("the classic preset draws no vector mark")
	}
	if classic == piTUILogo {
		t.Fatal("the classic preset is the TUI colors")
	}
	if classic != piClassicLogo {
		t.Fatal("the classic preset is not the silver mark")
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
