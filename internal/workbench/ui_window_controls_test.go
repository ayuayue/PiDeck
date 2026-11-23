//go:build !js && !android && !ios

package workbench

// Checks where the app draws the window's own buttons and where it leaves the
// platform's caption alone.

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

// windowControlsFixture renders the header's buttons on a simulated platform.
func windowControlsFixture(t *testing.T, osName core.OS) *nsgotest.App {
	t.Helper()
	if nsgotest.Target() != "" {
		t.Skip("driven headless; native runs verify the platform's caption")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	return nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a := newApp(cx)
		return core.View{Style: ui.FillRest, Children: []core.Node{a.windowControls()}}
	}, nsgotest.Size(1200, 860), nsgotest.Environment(core.Environment{OS: osName, Idiom: core.IdiomDesktop}))
}

// TestWindowControlsDrawnOnWindows checks the three buttons replace the
// caption the app hid.
func TestWindowControlsDrawnOnWindows(t *testing.T) {
	screen := windowControlsFixture(t, core.OSWindows)
	screen.WaitFor("id:window-controls", 5*time.Second)
	screen.Find("id:window-minimize")
	screen.Find("id:window-maximize")
	screen.Find("id:window-close")
	screen.Press("id:window-minimize")
}

// TestWindowControlsLeftToMacOS checks macOS keeps its traffic lights.
func TestWindowControlsLeftToMacOS(t *testing.T) {
	screen := windowControlsFixture(t, core.OSMacOS)
	screen.Settle()
	if got := len(screen.Query("id:window-controls")); got != 0 {
		t.Fatalf("macOS drew %d of its own window buttons, want the traffic lights", got)
	}
}
