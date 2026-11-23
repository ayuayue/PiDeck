//go:build !js && !android && !ios

package workbench

// Checks for the rail's project groups and pinning.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestProjectGroups checks pinned projects and named groups show as
// headings in the rail.
func TestProjectGroups(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	base := t.TempDir()
	mk := func(name string) string {
		dir := filepath.Join(base, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	alpha, beta, gamma := mk("alpha"), mk("beta"), mk("gamma")
	cfg := config{Version: 1, Theme: "system", SidebarOpen: true, ProjectSort: "title",
		Workspaces: []workspaceCfg{
			{Path: alpha, Expanded: true, Pinned: true, Added: time.Now()},
			{Path: beta, Expanded: true, Group: "工作", Added: time.Now()},
			{Path: gamma, Expanded: true, Group: "工作", Added: time.Now()},
		}}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:置顶")) > 0 })
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:工作")) > 0 })
	for _, name := range []string{"alpha", "beta", "gamma"} {
		app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:"+name)) > 0 })
	}
}

// TestAddingAndRemovingProjectRefreshRail checks the rail takes a new
// project on at once, and lets a removed one go: the list watches the
// projects, not just the revision pinning and grouping bump.
func TestAddingAndRemovingProjectRefreshRail(t *testing.T) {
	home := t.TempDir()
	first := t.TempDir()
	second := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	cfg := config{Version: 1, Theme: "system", SidebarOpen: true,
		Workspaces: []workspaceCfg{{Path: first, Expanded: true, Added: time.Now()}}}
	raw, err := json.Marshal(cfg)
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
	app.Press("text:" + filepath.Base(first))

	name := filepath.Base(second)
	app.PickDirectories = func(core.DirectoriesRequest) []core.Directory {
		return []core.Directory{{Name: name, Path: second}}
	}
	app.Press("id:add-project")
	app.WaitFor("text:本地目录…", 5*time.Second)
	app.Press("text:本地目录…")
	app.Settle()
	rows := app.Query("id:project-row")
	if len(rows) != 2 {
		t.Fatalf("after adding a project the rail has %d rows, want 2", len(rows))
	}
	if last := rows[len(rows)-1].Props.Label; last != name {
		t.Fatalf("the added project's row says %q, want %q", last, name)
	}

	if built == nil {
		t.Fatal("the app was not built")
	}
	ws := built.workspaceOf(second)
	if ws == nil {
		t.Fatal("the added folder is not a workspace")
	}
	built.removeWorkspaceNow(ws)
	app.Advance(300 * time.Millisecond)
	if got := len(app.Query("id:project-row")); got != 1 {
		t.Fatalf("after removing a project the rail has %d rows, want 1", got)
	}
}

// TestProjectSortMenusChooseAnOrder walks the two sort submenus and checks
// the choices reach the app instead of cycling through every mode.
func TestProjectSortMenusChooseAnOrder(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	raw, err := json.Marshal(config{Version: 1, Theme: "system", SidebarOpen: true, ScanPi: false,
		Workspaces: []workspaceCfg{{Path: project, Expanded: true, Added: time.Now()}}})
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

	openMenu := func(testID string) {
		t.Helper()
		for i := 0; i < 4; i++ {
			app.RightClick("id:project-row")
			if len(app.Query("id:"+testID)) > 0 {
				return
			}
			app.Advance(50 * time.Millisecond)
		}
		t.Fatalf("the menu item %q did not open", testID)
	}

	openMenu("project-sort-menu")
	app.Press("id:project-sort-menu")
	app.WaitFor("id:project-sort-title", 5*time.Second)
	app.Press("id:project-sort-title")
	app.WaitUntil(5*time.Second, func() bool {
		app.Settle()
		return built != nil && built.projectSortMode() == "title"
	})

	openMenu("session-sort-menu")
	app.Press("id:session-sort-menu")
	app.WaitFor("id:session-sort-name", 5*time.Second)
	app.Press("id:session-sort-name")
	app.WaitUntil(5*time.Second, func() bool {
		app.Settle()
		return built != nil && built.sessionSortMode() == "name"
	})
}
