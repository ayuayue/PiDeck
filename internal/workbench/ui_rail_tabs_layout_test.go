//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"math"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestRailHeaderStaysFixedWhileScrolling(t *testing.T) {
	projects := make([]string, 24)
	for i := range projects {
		projects[i] = t.TempDir()
	}
	_, screen := railFixture(t, projects...)
	waitProjects(t, screen, len(projects))

	for _, state := range []struct {
		height core.Points
		more   bool
	}{{800, false}, {520, false}, {520, true}} {
		screen.Resize(1200, state.height)
		if state.more {
			screen.Press("id:rail-more")
			screen.WaitFor("id:rail-agents", 5*time.Second)
		}
		screen.Settle()

		fixed := map[string]core.Bounds{}
		for _, id := range []string{"rail-brand", "rail-new-session", "rail-search", "rail-more",
			"rail-tab-activity", "rail-tab-chat", "rail-tab-projects", "sidebar-footer"} {
			fixed[id] = screen.Find("id:" + id).Bounds()
		}
		if state.more {
			fixed["rail-agents"] = screen.Find("id:rail-agents").Bounds()
		}
		listY := screen.Find("id:project-total").Bounds().Origin.Y
		screen.Scroll("id:project-total", 300)
		if got := screen.Find("id:project-total").Bounds().Origin.Y; got >= listY {
			t.Fatalf("height %v, more %v: list stayed at y=%v after scrolling from y=%v", state.height, state.more, got, listY)
		}
		for id, before := range fixed {
			if got := screen.Find("id:" + id).Bounds(); got != before {
				t.Fatalf("height %v, more %v: %s moved from %v to %v while the list scrolled", state.height, state.more, id, before, got)
			}
		}
		if nsgotest.Target() != "" {
			screen.Screenshot(fmt.Sprintf("rail/fixed-header-height-%v-more-%v", state.height, state.more))
		}
		screen.Scroll("id:project-total", -300)
	}
}

func TestRailTabsFillResizedSidebar(t *testing.T) {
	built, screen := railFixture(t)
	screen.WaitFor("id:rail-tab-projects", 5*time.Second)

	for _, width := range []core.Points{240, 292, 400, 280} {
		screen.Post(func() { built.railWidth.Set(width) })
		screen.Settle()

		row := screen.Find("id:rail-search").Bounds()
		wantWidth := (row.Size.Width - 4) / 3
		wantX := row.Origin.X
		for _, id := range []string{railTabActivity, railTabChat, railTabProjects} {
			tab := screen.Find("id:rail-tab-" + id).Bounds()
			if math.Abs(float64(tab.Size.Width-wantWidth)) > 1 || math.Abs(float64(tab.Origin.X-wantX)) > 1 {
				t.Fatalf("sidebar width %v: %s tab bounds = %v, want x=%v width=%v across row %v",
					width, id, tab, wantX, wantWidth, row)
			}
			wantX += wantWidth + 2
		}
		if nsgotest.Target() != "" {
			screen.Screenshot(fmt.Sprintf("rail/tabs-width-%v", width))
		}
	}
}
