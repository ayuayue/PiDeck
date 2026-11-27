//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func startGitStatusApp(t *testing.T, cfg config) (*app, *nsgotest.App) {
	t.Helper()
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Cleanup(configWrites.Wait)
	cfg.Version, cfg.Theme = 2, "light"
	cfg.SidebarOpen = true
	cfg.ScanPi, cfg.AutoModelCatalog = false, false
	disabled := false
	cfg.TelemetryEnabled = &disabled
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1320, 860))
	t.Cleanup(built.closeDiag)
	return built, screen
}

func TestGitCountFollowsActiveProject(t *testing.T) {
	first, _ := gitFixture(t)
	second, _ := gitFixture(t)
	for _, path := range []string{filepath.Join(first, "first.txt"), filepath.Join(second, "one.txt"), filepath.Join(second, "two.txt")} {
		if err := os.WriteFile(path, []byte("change\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	a, screen := startGitStatusApp(t, config{DrawerOpen: true, DrawerTab: "git",
		Workspaces: []workspaceCfg{{Path: first, Name: "First"}, {Path: second, Name: "Second"}}})
	screen.WaitUntil(20*time.Second, func() bool { return !a.git.working })
	if got := a.git.state.GetUntracked(); !got.IsRepo || len(got.Files) != 1 {
		t.Fatalf("initial project status = %+v, want one change", got)
	}
	screen.Press("id:drawer-tab-files")
	// A project without sessions changes activeWS directly, like a rail click.
	screen.Post(func() { a.openWorkspaceKey(localTarget.key() + "|" + second) })
	screen.Settle()
	if _, path := a.git.repo(); path != second {
		t.Fatalf("repository after project switch = %q, want %q", path, second)
	}
	screen.WaitUntil(20*time.Second, func() bool { return !a.git.working })
	if got := a.git.state.GetUntracked(); !got.IsRepo || len(got.Files) != 2 {
		t.Fatalf("second project status = %+v, want two changes", got)
	}

	// Opening Git from another project's menu must select that same project.
	screen.Post(func() { a.openGitFor(a.workspaceOf(first)) })
	screen.Settle()
	if ws := a.activeWorkspace(); ws == nil || ws.Path != first {
		t.Fatalf("Git project action left a different active project: %+v", ws)
	}
	screen.WaitUntil(20*time.Second, func() bool { return !a.git.working })
	if got := a.git.state.GetUntracked(); len(got.Files) != 1 {
		t.Fatalf("project menu status = %+v, want one change", got)
	}
}

func TestGitCountRefreshesWithoutGitPanel(t *testing.T) {
	dir, run := gitFixture(t)
	a, screen := startGitStatusApp(t, config{DrawerOpen: true, DrawerTab: "git",
		Workspaces: []workspaceCfg{{Path: dir}}})
	screen.WaitUntil(20*time.Second, func() bool { return !a.git.working })
	for _, tab := range []string{"files", "closed"} {
		t.Run(tab, func(t *testing.T) {
			screen.Post(func() {
				a.drawerTab.Set("files")
				a.drawer.Set(tab != "closed")
			})
			screen.Settle()
			if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte(tab+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			screen.Advance(4 * time.Second)
			screen.WaitUntil(10*time.Second, func() bool { return !a.git.working })
			if got := a.git.state.GetUntracked(); len(got.Files) != 1 {
				t.Fatalf("external edit was not polled with %s panel: %+v", tab, got)
			}
			run("commit", "-am", "external "+tab)
			screen.Advance(4 * time.Second)
			screen.WaitUntil(10*time.Second, func() bool { return !a.git.working })
			if got := a.git.state.GetUntracked(); len(got.Files) != 0 {
				t.Fatalf("external commit left a stale count with %s panel: %+v", tab, got)
			}
		})
	}

	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("in-app commit\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	screen.Advance(4 * time.Second)
	screen.WaitUntil(10*time.Second, func() bool { return !a.git.working })
	screen.Post(func() {
		a.git.msg.Set("in-app commit")
		a.gitCommit(true, false)
	})
	screen.Settle()
	// Application actions refresh immediately, without another timer tick.
	screen.WaitUntil(20*time.Second, func() bool { return !a.git.running && !a.git.working })
	if got := a.git.state.GetUntracked(); len(got.Files) != 0 || a.git.err.GetUntracked() != "" {
		t.Fatalf("in-app commit did not clear the count: %+v, error %q", got, a.git.err.GetUntracked())
	}
	if got := run("log", "-1", "--format=%s"); got != "in-app commit\n" {
		t.Fatalf("latest commit = %q, want in-app commit", got)
	}
}

func TestGitCountLoadsWithDrawerClosed(t *testing.T) {
	dir, _ := gitFixture(t)
	if err := os.WriteFile(filepath.Join(dir, "new.txt"), []byte("change\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a, screen := startGitStatusApp(t, config{Workspaces: []workspaceCfg{{Path: dir}}})
	screen.WaitUntil(20*time.Second, func() bool { return !a.git.working })
	if got := a.git.state.GetUntracked(); !got.IsRepo || len(got.Files) != 1 {
		t.Fatalf("startup with drawer closed did not load the change count: %+v", got)
	}
}
