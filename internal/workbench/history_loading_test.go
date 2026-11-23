//go:build !js && !android && !ios

package workbench

// Checks the transcript placeholder while a session's history is read.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestHistoryLoadingSkeleton shows the transcript's pulse while a session
// is not loaded yet, and the empty state once it is.
func TestHistoryLoadingSkeleton(t *testing.T) {
	home := t.TempDir()
	workspace := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "HistoryProject"}},
		Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	var built *app
	root := func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}
	screen := nsgotest.Start(t, root, nsgotest.Size(1320, 860))
	if built == nil {
		t.Fatal("the app was not built")
	}
	ws := built.workspaces.GetUntracked()[0]
	s := built.makeSession(sessionMeta{ID: "history-loading", Cwd: ws.Path, Title: "历史加载", Updated: time.Now()}, ws.Target)
	built.activeID.Set(s.ID)
	built.activeWS.Set(ws.Path)
	screen.Advance(250 * time.Millisecond)
	screen.WaitFor("id:history-skeleton", 5*time.Second)
	shot(screen, "52-history-loading")

	s.loaded.Set(true)
	screen.Advance(250 * time.Millisecond)
	if got := len(screen.Query("id:history-skeleton")); got != 0 {
		t.Fatalf("history skeleton = %d after loading, want 0", got)
	}
}
