//go:build !js && !android && !ios

package workbench

// Checks session list ordering and its headings.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestSessionNameSortUsesOneHeading keeps name order from being cut into
// today/yesterday buckets, which would repeat headings and break the order.
func TestSessionNameSortUsesOneHeading(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	raw, err := json.Marshal(config{Version: 1, Theme: "system", SidebarOpen: true, ScanPi: false,
		SessionSort: "name",
		Workspaces:  []workspaceCfg{{Path: project, Expanded: true, Added: time.Now()}}})
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
	app := nsgotest.Start(t, root, nsgotest.Size(1200, 800))
	app.WaitFor("id:project-row", 5*time.Second)
	if built == nil {
		t.Fatal("the app was not built")
	}
	ws := built.workspaceOf(project)
	now := time.Now()
	ws.Pi.Set([]*session{
		built.makeSession(sessionMeta{ID: "bravo", Cwd: project, Title: "Bravo", Updated: now}, localTarget),
		built.makeSession(sessionMeta{ID: "alpha", Cwd: project, Title: "Alpha", Updated: now.Add(-30 * time.Hour)}, localTarget),
	})
	app.WaitUntil(5*time.Second, func() bool {
		app.Settle()
		return len(app.Query("id:session-row")) == 2
	})

	rows := app.Query("id:session-row")
	if got := rows[0].Props.Label; got != "Alpha" {
		t.Fatalf("first name-sorted session = %q, want Alpha", got)
	}
	if got := len(app.Query("text:名称")); got != 1 {
		t.Fatalf("name-sort headings = %d, want 1", got)
	}
	if got := len(app.Query("text:今天")); got != 0 {
		t.Fatalf("name sort kept %d time headings", got)
	}
}
