//go:build !js && !android && !ios

package workbench

// Checks that projects scan the session stores pi's settings point them at.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestPiSessionRootsFollowProjectSettings keeps the default store and adds
// the project's configured one, with the project setting winning over the
// global one.
func TestPiSessionRootsFollowProjectSettings(t *testing.T) {
	globalStore := t.TempDir()
	configDir := t.TempDir()
	project := t.TempDir()
	projectStore := filepath.Join(project, ".pi", "sessions")
	fallbackStore := t.TempDir()
	if err := os.MkdirAll(projectStore, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(project, ".pi"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".pi", "settings.json"),
		[]byte(`{"sessionDir":".pi/sessions"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "settings.json"),
		[]byte(`{"sessionDir":`+jsonString(fallbackStore)+`}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", globalStore)
	t.Setenv("PIDECK_V2_PI_CONFIG", configDir)

	roots := piSessionRoots([]string{project, project})
	if len(roots) != 2 {
		t.Fatalf("roots = %v, want the default and project stores", roots)
	}
	if !samePath(roots[0], globalStore) || !samePath(roots[1], projectStore) {
		t.Fatalf("roots = %v, want %q then %q", roots, globalStore, projectStore)
	}
}

// TestPiSessionRootsFallBackToGlobal checks a project with no sessionDir
// uses the global one.
func TestPiSessionRootsFallBackToGlobal(t *testing.T) {
	globalStore := t.TempDir()
	configDir := t.TempDir()
	project := t.TempDir()
	configured := filepath.Join(t.TempDir(), "global-sessions")
	if err := os.MkdirAll(configured, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "settings.json"),
		[]byte(`{"sessionDir":`+jsonString(configured)+`}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", globalStore)
	t.Setenv("PIDECK_V2_PI_CONFIG", configDir)

	roots := piSessionRoots([]string{project})
	if len(roots) != 2 || !samePath(roots[1], configured) {
		t.Fatalf("roots = %v, want the default and %q", roots, configured)
	}
}

// TestResolvePiSessionDirExpandsHome follows pi's path rules.
func TestResolvePiSessionDirExpandsHome(t *testing.T) {
	project := t.TempDir()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := resolvePiSessionDir("~/.pi/sessions", project), filepath.Join(home, ".pi", "sessions"); !samePath(got, want) {
		t.Fatalf("~ path = %q, want %q", got, want)
	}
	if got, want := resolvePiSessionDir(".pi/sessions", project), filepath.Join(project, ".pi", "sessions"); !samePath(got, want) {
		t.Fatalf("relative path = %q, want %q", got, want)
	}
}

// TestPiScanIncludesProjectSessionDir reproduces a project whose sessions
// live in .pi/sessions: they must show in the rail even when the global
// store is empty.
func TestPiScanIncludesProjectSessionDir(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	globalStore := t.TempDir()
	configDir := t.TempDir()
	localStore := filepath.Join(project, ".pi", "sessions")
	if err := os.MkdirAll(localStore, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".pi", "settings.json"),
		[]byte(`{"sessionDir":".pi/sessions"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	writeSession(t, localStore, "only-local.jsonl", piSessionFile("only-local", project))
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", configDir)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", globalStore)
	raw, err := json.Marshal(config{Version: 1, Theme: "system", SidebarOpen: true, ScanPi: true,
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
	app := nsgotest.Start(t, root, nsgotest.Size(1200, 820))
	app.WaitUntil(20*time.Second, func() bool {
		app.Settle()
		if built == nil {
			return false
		}
		ws := built.workspaceOf(project)
		return ws != nil && len(ws.Pi.GetUntracked()) == 1
	})
	app.WaitFor("id:session-row", 5*time.Second)
}

// TestProjectDefaultSortIsRecent leaves ProjectSort unset, as an existing
// config can, and expects the project with the newest session first.
func TestProjectDefaultSortIsRecent(t *testing.T) {
	home := t.TempDir()
	older := t.TempDir()
	newer := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	raw, err := json.Marshal(config{Version: 1, Theme: "system", SidebarOpen: true, ScanPi: false,
		Workspaces: []workspaceCfg{
			{Path: older, Added: time.Now().Add(-time.Hour)},
			{Path: newer, Added: time.Now()},
		}})
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
	nsgotest.Start(t, root, nsgotest.Size(1200, 820))
	if built == nil {
		t.Fatal("the app was not built")
	}
	oldWS, newWS := built.workspaceOf(older), built.workspaceOf(newer)
	oldWS.Pi.Set([]*session{built.makeSession(sessionMeta{ID: "old", Cwd: older, Updated: time.Now().Add(-time.Hour)}, localTarget)})
	newWS.Pi.Set([]*session{built.makeSession(sessionMeta{ID: "new", Cwd: newer, Updated: time.Now()}, localTarget)})

	list := []*workspace{oldWS, newWS}
	built.sortProjects(list)
	if list[0] != newWS {
		t.Fatalf("default project order starts with %q, want the recent project", list[0].Path)
	}
}

// jsonString quotes a path as a JSON string.
func jsonString(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}
