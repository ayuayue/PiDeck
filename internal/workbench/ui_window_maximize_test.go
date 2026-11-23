//go:build !js && !android && !ios

package workbench

// Checks a window brought back by a clicked notification comes back at the
// maximized state the app remembers: the platform's own restore of a hidden
// window drops it.

import (
	"testing"
	"time"
)

// TestWindowWantsMaximize checks the decision behind the restore, which the
// platform's ShowWindow and ToggleMaximize cannot show headless.
func TestWindowWantsMaximize(t *testing.T) {
	for _, c := range []struct {
		name      string
		cfg       windowCfg
		maximized bool
		want      bool
	}{
		{"saved maximized, restored windowed", windowCfg{W: 1440, H: 900, Maximized: true}, false, true},
		{"saved maximized, still maximized", windowCfg{W: 1440, H: 900, Maximized: true}, true, false},
		{"the user left it windowed", windowCfg{W: 1440, H: 900}, false, false},
		{"a first run has no frame", windowCfg{}, false, false},
		{"a frame too small to be a window", windowCfg{W: 300, H: 200, Maximized: true}, false, false},
	} {
		if got := windowWantsMaximize(c.cfg, c.maximized); got != c.want {
			t.Errorf("%s: maximize again = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestNotificationPressLeavesWindowedWindow checks showing the window again
// does not maximize one the user left windowed.
func TestNotificationPressLeavesWindowedWindow(t *testing.T) {
	built, screen := headerFixture(t, config{Window: windowCfg{X: 100, Y: 60, W: 1440, H: 900}}, 1)
	screen.Post(func() { built.showMainWindow() })
	screen.Advance(500 * time.Millisecond)
	if built.cx.Env().Maximized() {
		t.Fatal("clicking a notification maximized a window the user left windowed")
	}
}
