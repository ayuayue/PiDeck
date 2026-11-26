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
