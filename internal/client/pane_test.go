package client

// A surface is a sheet on a phone and a column beside the page on a window as
// wide as a desktop's: these check both sides of that break, that a resize
// crosses it, and that the way out of the column closes what it shows.

import (
	"testing"
	"time"

	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

// paneScreen draws one surface's frame at a window size, its open state kept
// where the test can read it.
func paneScreen(t *testing.T, width core.Points, initially bool) (*nsgotest.App, func() bool) {
	t.Helper()
	var open *core.Signal[bool]
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		if open == nil {
			open = core.NewSignal(cx, initially)
		}
		cx.SetTheme(viewkit.Theme())
		return core.Dynamic(func(cx *core.Scope) core.Node {
			return core.View{Style: ui.FillRest, Children: []core.Node{
				sheetFrame(cx, sheetSpec{
					title: "Git · 电脑项目", testID: "pane", width: 520,
					open:  func() bool { return open.Get() },
					close: func() { open.Set(false) },
					body:  []core.Node{core.Text{Content: "main"}},
					footer: []core.Node{ui.Button{Text: "刷新", Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						OnPress: func() {}}},
				}),
			}}
		})
	}, nsgotest.Size(width, 900))
	return app, func() bool { return open.GetUntracked() }
}

// TestSheetFrameFollowsTheWindowWidth guards the break: a phone gets the sheet
// it always had, a wide window the column with its own title row, and a
// resize crosses between them without losing the surface.
func TestSheetFrameFollowsTheWindowWidth(t *testing.T) {
	app, _ := paneScreen(t, 420, true)
	app.WaitFor("id:pane", 5*time.Second)
	app.WaitFor("text:main", 5*time.Second)
	if n := len(app.Query("id:pane-pane-close")); n != 0 {
		t.Fatalf("a phone drew the column's title row %d times", n)
	}
	app.Resize(1280, 900)
	app.WaitFor("id:pane-pane-close", 5*time.Second)
	app.WaitFor("text:刷新", 5*time.Second)
	app.Resize(420, 900)
	app.WaitForGone("id:pane-pane-close", 5*time.Second)
}

// TestPaneTitleRowClosesTheSurface guards the column's way out: closing it
// closes the surface, not just the column.
func TestPaneTitleRowClosesTheSurface(t *testing.T) {
	app, isOpen := paneScreen(t, 1280, true)
	app.WaitFor("id:pane-pane-close", 5*time.Second)
	app.Press("id:pane-pane-close")
	app.WaitForGone("id:pane", 5*time.Second)
	if isOpen() {
		t.Fatal("the column's close button left the surface open")
	}
}

// TestPaneWidthStaysReadable guards the column's width: a third of the window
// within the bounds of a panel a diff can be read in.
func TestPaneWidthStaysReadable(t *testing.T) {
	for _, tc := range []struct{ width, want core.Points }{
		{1100, 374}, {1280, 435.2}, {2000, 520}, {4000, 520},
	} {
		want, width := tc.want, tc.width
		app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
			if got := paneWidth(cx); got != want {
				t.Errorf("paneWidth(%v) = %v; want %v", width, got, want)
			}
			return core.Text{Content: "ok"}
		}, nsgotest.Size(width, 900))
		app.Settle()
	}
}
