//go:build !js && !android && !ios

package workbench

// Settings pages redraw through a Dynamic, which clears its subtree and with
// it the scroll view's offset. These cover the stash that gives the reader's
// place back.

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestSettingsScrollSurvivesAChange flips a switch far down the general page
// and expects the page to stay where it was.
func TestSettingsScrollSurvivesAChange(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 620))
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-general", 5*time.Second)
	app.Press("id:settings-tab-general")
	app.WaitFor("id:settings-page", 5*time.Second)
	app.Settle()
	app.ScrollTo("id:settings-page", core.Point{Y: 320})
	app.Advance(300 * time.Millisecond)
	before := app.Find("id:settings-page").Offset.Y
	if before <= 0 {
		t.Skip("the general page does not scroll in this window")
	}
	app.Press("id:notify-done")
	app.Advance(300 * time.Millisecond)
	after := app.Find("id:settings-page").Offset.Y
	if after != before {
		t.Fatalf("the page scrolled from %v to %v after a switch", before, after)
	}
}
