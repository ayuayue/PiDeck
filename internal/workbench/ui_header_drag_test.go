//go:build !js && !android && !ios

package workbench

// Checks the header is the window's handle on a desktop whose title bar the
// shell hid: the run beside the tabs drags the window while the tabs keep
// their own presses, and the tabs still scroll inside the strip.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// headerFixture opens the window as Windows shows it: the shell's own header
// at the window's top, over a hidden title bar, with a caption's width kept
// free at the end.
func headerFixture(t *testing.T, cfg config, sessions int) (*app, *nsgotest.App) {
	t.Helper()
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run verifies the drag itself")
	}
	home, dir := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	cfg.Version = 1
	cfg.Workspaces = []workspaceCfg{{Path: dir, Name: "Drag"}}
	cfg.Theme = "system"
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() },
		nsgotest.Size(1200, 800), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop,
			TitleBar: core.Edges{Top: 48, Right: 138}}))
	screen.Advance(200 * time.Millisecond)
	if built == nil {
		t.Fatal("the app did not start")
	}
	ws := &workspace{Path: dir}
	var ids []string
	for i := 0; i < sessions; i++ {
		s := built.blankSession(fmt.Sprintf("drag-%d", i), ws, fmt.Sprintf("会话 %d", i))
		built.byID[s.ID] = s
		built.all = append(built.all, s)
		ids = append(ids, s.ID)
	}
	built.tabs.Set(ids)
	if len(ids) > 0 {
		built.activeID.Set(ids[0])
	}
	screen.Advance(100 * time.Millisecond)
	return built, screen
}

// TestTabStripDragsWindow checks the run beside the tabs is a window handle,
// so the header moves the window instead of only its buttons working.
func TestTabStripDragsWindow(t *testing.T) {
	_, screen := headerFixture(t, config{}, 1)
	drag := screen.WaitFor("id:tab-bar-drag", 5*time.Second)
	if drag.Props.WindowDrag != core.WindowDragOn {
		t.Fatalf("the tab strip's empty run drags %v, want WindowDragOn", drag.Props.WindowDrag)
	}
	if drag.Frame.Size.Width < 100 {
		t.Fatalf("the handle is %v wide, want the run after the tabs", drag.Frame.Size.Width)
	}
	// The tabs keep their presses: a handle over them would swallow selecting
	// a session.
	if tab := screen.Find("id:tab"); tab.Props.WindowDrag == core.WindowDragOn {
		t.Fatal("the tab itself became a window handle")
	}
}

// TestTabStripKeepsControlsInsideWindow checks the tabs still scroll inside
// the strip: they must not push the header's buttons past the window.
func TestTabStripKeepsControlsInsideWindow(t *testing.T) {
	_, screen := headerFixture(t, config{}, 14)
	screen.WaitFor("id:tab-bar", 5*time.Second)
	controls := screen.Find("id:window-controls")
	if right := controls.Frame.Origin.X + controls.Frame.Size.Width; right > 1200 {
		t.Fatalf("the window controls end at %v, outside the 1200 window", right)
	}
}
