//go:build !js && !android && !ios

package workbench

// Checks the prewarmed pi process: it is only kept for a real install in a
// local project, it belongs to one project, and a new session takes it over
// instead of booting pi.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// warmTestApp starts the app on a project with a remembered model and no
// sessions on disk, and returns it with the app behind the screen.
func warmTestApp(t *testing.T) (*app, *nsgotest.App, *workspace) {
	t.Helper()
	home, dir := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Theme: "system", SidebarOpen: true,
		Model:      modelChoice{Provider: "test", ID: "test/model"},
		Workspaces: []workspaceCfg{{Path: dir, Name: "Warm"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	screen.Advance(100 * time.Millisecond)
	if built == nil {
		t.Fatal("the app did not start")
	}
	ws := built.workspaceOf(dir)
	if ws == nil {
		t.Fatal("the project did not load")
	}
	return built, screen, ws
}

// TestNewSessionStartsNoProcess keeps a new tab out of the process list:
// its backend is still the user's to pick, so a switch to ACP must not pay
// for a pi launch nobody used.
func TestNewSessionStartsNoProcess(t *testing.T) {
	built, screen, ws := warmTestApp(t)
	s := built.newProjectSession(ws)
	if s == nil {
		t.Fatal("no session was made")
	}
	screen.Advance(100 * time.Millisecond)
	if s.engine != nil || s.starting || s.warmPi != nil {
		t.Fatalf("a blank session started a process: engine=%v starting=%v warm=%v", s.engine, s.starting, s.warmPi)
	}
	if got := s.model.GetUntracked().ID; got != "test/model" {
		t.Fatalf("model chip = %q, want the remembered default before pi starts", got)
	}
	if got := built.warmPiInfo(); got != nil {
		t.Fatalf("a spare booted without sessions on disk: %+v", got)
	}
}

// TestSwitchToACPReleasesWarmProcess checks a tab moving to ACP drops the
// prewarmed pi it held, so the switch frees the process too.
func TestSwitchToACPReleasesWarmProcess(t *testing.T) {
	built, screen, ws := warmTestApp(t)
	s := built.newProjectSession(ws)
	s.warmPi = &warmPi{C: &piClient{in: nopWriteCloser{}}}
	preset, err := json.Marshal(map[string]any{"presets": []map[string]any{{
		"id": "fake", "name": "Fake Agent", "command": os.Args[0], "args": []string{"-test.run=^TestFakeACPAgent$"},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(built.st.dir, "acp")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "fake.json"), preset, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_FAKE_ACP", "1")
	t.Setenv("PIDECK_FAKE_ACP_UI", "1")
	t.Cleanup(closeAllACP)
	built.setBackend(s, "acp", "fake")
	screen.Advance(50 * time.Millisecond)
	if s.warmPi != nil {
		t.Fatal("the blank session kept its prewarmed pi after moving to ACP")
	}
	built.detachACP(s)
}

// nopWriteCloser is a stand-in for a child's stdin.
type nopWriteCloser struct{}

func (nopWriteCloser) Write(p []byte) (int, error) { return len(p), nil }
func (nopWriteCloser) Close() error                { return nil }

// TestPiWarmPoolMatchesOneProject checks a spare is only handed to a
// session in the project it was booted for.
func TestPiWarmPoolMatchesOneProject(t *testing.T) {
	built := &app{warmOK: true}
	spare := &warmPi{ID: "w1", Dir: "/proj/a", Target: target{Kind: targetLocal}, C: &piClient{}}
	built.warm = spare
	if got := built.takeWarmPi(&workspace{Path: "/proj/b"}); got != nil {
		t.Fatalf("a spare for another project was handed over: %+v", got)
	}
	if built.warmPiInfo() != spare {
		t.Fatal("the spare was dropped by a mismatch")
	}
	if got := built.takeWarmPi(&workspace{Path: "/proj/a"}); got != spare {
		t.Fatalf("take = %+v, want the spare", got)
	}
	if built.warmPiInfo() != nil {
		t.Fatal("the spare stayed in the pool after being taken")
	}
	built.warm = spare
	built.dropWarmPi("other")
	if built.warmPiInfo() != spare {
		t.Fatal("a process that ended elsewhere dropped the spare")
	}
	built.dropWarmPi("w1")
	if built.warmPiInfo() != nil {
		t.Fatal("the dead spare stayed in the pool")
	}
}

// TestPiWarmSkipsPrivateTools keeps the spare from standing in for a
// session whose memory server token it cannot carry.
func TestPiWarmSkipsPrivateTools(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	built := &app{warmOK: true, st: st}
	ws := &workspace{Path: "/proj"}
	if !built.warmEligible(ws) {
		t.Fatal("a local project is not eligible")
	}
	built.cfg.MemoryTools = true
	if built.warmEligible(ws) {
		t.Fatal("a project with session memory tools keeps a spare that cannot serve them")
	}
	built.cfg.MemoryTools = false
	remote := &workspace{Path: "/proj", Target: target{Kind: targetSSH, Host: "box"}}
	if built.warmEligible(remote) {
		t.Fatal("a remote project keeps a local spare")
	}
}

// TestPiWarmAdoptionTakesOverProcess boots a spare and lets a new session
// use it, which is the difference between a tab that thinks and one that
// waits for pi.
func TestPiWarmAdoptionTakesOverProcess(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("drives a real pi")
	}
	requirePi(t)
	built, screen, ws := warmTestApp(t)
	t.Cleanup(closeAllPi)
	built.warmOK = true
	built.ensureWarmPi(ws)
	var spare *warmPi
	screen.WaitUntil(60*time.Second, func() bool {
		spare = built.warmPiInfo()
		return spare != nil
	})
	if spare == nil {
		t.Fatal("pi was not prewarmed")
	}
	s := built.newProjectSession(ws)
	if s.warmPi == nil {
		t.Fatal("the new session did not adopt the spare")
	}
	pid := s.warmPi.C.pid()
	built.ensureEngine(s, nil)
	screen.WaitUntil(60*time.Second, func() bool { return s.engine != nil })
	if s.engine == nil {
		t.Fatalf("the adopted process never became the session's engine: %s", s.notice.GetUntracked())
	}
	if s.warmPi != nil {
		t.Fatal("the session kept the spare after taking it over")
	}
	if s.engine.pid() != pid {
		t.Fatalf("engine pid = %d, want the prewarmed %d", s.engine.pid(), pid)
	}
	if s.model.GetUntracked().ID == "" {
		t.Fatal("the adopted process reported no model")
	}
}
