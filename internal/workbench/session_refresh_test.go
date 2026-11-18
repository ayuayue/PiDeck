//go:build !js && !android && !ios

package workbench

// Checks that a project's pi history keeps up with pi's own store: a
// session started somewhere else appears while the app runs, a pass that
// found nothing new leaves the rail's rows alone, and a folder spelled in
// another case is still the same folder.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// piSessionFile is one pi session file for a folder.
func piSessionFile(id, cwd string) string {
	head, _ := json.Marshal(map[string]any{"type": "session", "id": id, "cwd": cwd,
		"timestamp": "2026-11-01T10:00:00Z"})
	return string(head) + "\n" +
		`{"type":"message","id":"m-` + id + `","timestamp":"2026-11-01T10:00:01Z",` +
		`"message":{"role":"user","content":"` + id + `"}}` + "\n"
}

// startProjectApp starts the app with one project holding one pi session,
// and returns the app, the app behind it, the project's folder and pi's
// store's folder for that project.
func startProjectApp(t *testing.T, cwd func(proj string) string) (*nsgotest.App, *app, string, string) {
	t.Helper()
	home := t.TempDir()
	proj := t.TempDir()
	store := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", store)
	dir := filepath.Join(store, "--pi--")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.jsonl"), []byte(piSessionFile("a", cwd(proj))), 0o644); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(config{Version: 1, Theme: "system", SidebarOpen: true, ScanPi: true,
		Workspaces: []workspaceCfg{{Path: proj, Expanded: true, Added: time.Now()}}})
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
	if built == nil {
		t.Fatal("the app was not built")
	}
	// The probe that starts the app's pi scan answers in the background;
	// wait for it so a later pass is the only thing that can find a new
	// session.
	app.WaitUntil(10*time.Second, func() bool { return built.env.GetUntracked().Probed })
	app.Settle()
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:session-row")) == 1 })
	return app, built, proj, dir
}

// TestPiRefreshFindsSessionsStartedElsewhere checks the rail's background
// pass: a session pi wrote after the app started appears within a scan, and
// a pass with nothing new keeps the list the rail holds.
func TestPiRefreshFindsSessionsStartedElsewhere(t *testing.T) {
	app, built, proj, dir := startProjectApp(t, func(proj string) string { return proj })
	list := built.workspaceOf(proj).Pi.GetUntracked()

	// A session started in a terminal while the app runs.
	if err := os.WriteFile(filepath.Join(dir, "b.jsonl"), []byte(piSessionFile("b", proj)), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		app.Advance(time.Second)
		app.Settle()
		if len(app.Query("id:session-row")) == 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := len(app.Query("id:session-row")); got != 2 {
		t.Fatalf("session rows after a session started elsewhere = %d, want 2", got)
	}

	// Nothing changed since: the pass leaves the same list in place instead
	// of rebuilding the same rows.
	list = built.workspaceOf(proj).Pi.GetUntracked()
	app.Advance(time.Duration(piScanEvery+2) * time.Second)
	app.Settle()
	nowList := built.workspaceOf(proj).Pi.GetUntracked()
	if len(list) != 2 || len(nowList) != 2 {
		t.Fatalf("rows after an unchanged pass = %d and %d, want 2 and 2", len(list), len(nowList))
	}
	if &list[0] != &nowList[0] {
		t.Fatal("an unchanged pass replaced the rail's list")
	}
}

// TestPiScanFindsAFolderSpelledInAnotherCase checks that the project and the
// folder a session ran in are the same folder when only the case differs,
// as Windows writes them both ways.
func TestPiScanFindsAFolderSpelledInAnotherCase(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("only Windows folds the case of a path")
	}
	app, built, proj, _ := startProjectApp(t, strings.ToLower)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:session-row")) == 1 })
	if got := len(built.workspaceOf(proj).Pi.GetUntracked()); got != 1 {
		t.Fatalf("sessions of a folder spelled in another case = %d, want 1", got)
	}
}
