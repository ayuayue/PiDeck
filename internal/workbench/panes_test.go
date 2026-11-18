//go:build !js && !android && !ios

package workbench

// Checks the split panes: opening one gives it a tab in the tab bar, a
// second pane replaces it there and both tabs stay, and closing or
// finishing a pane takes its tab away.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestSplitPanes(t *testing.T) {
	if testing.Short() {
		t.Skip("driven headless")
	}
	home, workspace := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, _ := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "Panes"}},
		Theme: "system", SidebarOpen: true})
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1320, 860))
	screen.Advance(200 * time.Millisecond)
	if built == nil {
		t.Fatal("the app did not start")
	}

	// Opening a pane fills the work area and gives it a tab.
	built.openFavorites()
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("id:favorites-dialog")) == 0 {
		t.Fatal("the favorites pane did not show")
	}
	if len(screen.Query("id:pane-tab-favorites")) == 0 {
		t.Fatal("the favorites pane has no tab")
	}
	shot(screen, "50-pane-favorites")

	// A second pane takes the work area over; both tabs stay.
	built.openTaskDialog()
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("id:tasks-dialog")) == 0 {
		t.Fatal("the tasks pane did not show")
	}
	if len(screen.Query("id:favorites-dialog")) != 0 {
		t.Fatal("the favorites pane stayed under the tasks pane")
	}
	if len(screen.Query("id:pane-tab-favorites")) == 0 || len(screen.Query("id:pane-tab-tasks")) == 0 {
		t.Fatal("the open panes lost their tabs")
	}
	shot(screen, "51-pane-tasks")

	// The agents pane carries its form under the list.
	built.openAgentManager()
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("id:agent-manager")) == 0 {
		t.Fatal("the agents pane did not show")
	}
	shot(screen, "52-pane-agents")

	// Its tab brings a pane back.
	screen.Press("id:pane-tab-favorites")
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("id:favorites-dialog")) == 0 {
		t.Fatal("the favorites tab did not bring its page back")
	}

	// Closing the tab closes the page.
	screen.Press("id:pane-tab-close-favorites")
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("id:favorites-dialog")) != 0 || len(screen.Query("id:pane-tab-favorites")) != 0 {
		t.Fatal("closing the tab did not close the pane")
	}

	// Settings closes from its own button.
	built.openSettingsPane()
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("id:settings")) == 0 {
		t.Fatal("the settings pane did not show")
	}
	shot(screen, "53-pane-settings")
	screen.Press("id:settings-done")
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("id:settings")) != 0 || len(screen.Query("id:pane-tab-settings")) != 0 {
		t.Fatal("settings did not close")
	}

	// The close command closes the pane that shows.
	built.openTaskDialog()
	screen.Advance(50 * time.Millisecond)
	built.runCommand("close-tab")
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("id:tasks-dialog")) != 0 {
		t.Fatal("the close command left the pane up")
	}
}
