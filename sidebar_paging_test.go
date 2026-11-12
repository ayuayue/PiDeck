package main

// Checks the rail's first page of a project's sessions, "更多" adding the
// next step, and "收起" returning to the first page.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/nsgotest"
)

// TestProjectSessionPaging builds 25 pi sessions in one project and drives
// the paging controls.
func TestProjectSessionPaging(t *testing.T) {
	home := t.TempDir()
	workspace := t.TempDir()
	piSessions := t.TempDir()
	dir := filepath.Join(piSessions, "--paging--")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for i := 0; i < 25; i++ {
		id := fmt.Sprintf("aaaaaaaa-2222-4333-8444-%012d", i+1)
		at := now.Add(-time.Duration(i) * time.Minute)
		ts := at.Format("2006-01-02T15:04:05.000Z")
		header, _ := json.Marshal(map[string]any{"type": "session", "version": 3, "id": id, "timestamp": ts,
			"cwd": filepath.ToSlash(workspace)})
		message, _ := json.Marshal(map[string]any{"type": "message", "id": "m-" + id, "timestamp": ts,
			"message": map[string]any{"role": "user", "content": fmt.Sprintf("会话 %02d", i+1), "timestamp": 1767323046000}})
		name := filepath.Join(dir, at.Format("2006-01-02T15-04-05-000Z")+"_"+id+".jsonl")
		if err := os.WriteFile(name, append(append(header, '\n'), message...), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", piSessions)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "PagingProject"}},
		Theme: "system", SidebarOpen: true, ScanPi: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	app.Press("text:PagingProject")
	waitCount := func(want int) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			app.Settle()
			if len(app.Query("id:session-row")) == want {
				return
			}
			time.Sleep(30 * time.Millisecond)
		}
		t.Fatalf("session rows = %d, want %d", len(app.Query("id:session-row")), want)
	}
	waitCount(10)
	app.WaitFor("text:25", 5*time.Second)
	app.WaitFor("id:project-more", 5*time.Second)
	shot(app, "50-project-page")

	app.Press("id:project-more")
	app.Advance(300 * time.Millisecond)
	waitCount(25)
	app.WaitFor("id:project-collapse", 5*time.Second)
	shot(app, "51-project-more")

	app.Press("id:project-collapse")
	app.Advance(300 * time.Millisecond)
	waitCount(10)
}

// TestProjectLoadingSkeleton shows the pulse placeholders while a project's
// history is still unknown, and the rows once it arrives.
func TestProjectLoadingSkeleton(t *testing.T) {
	home := t.TempDir()
	workspace := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "LoadingProject"}},
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
	screen.Press("text:LoadingProject")
	screen.Advance(350 * time.Millisecond)
	if built == nil {
		t.Fatal("the app was not built")
	}
	ws := built.workspaces.GetUntracked()[0]
	ws.PiLoading.Set(true)
	screen.Advance(200 * time.Millisecond)
	if got := len(screen.Query("id:project-loading-row")); got != 3 {
		t.Fatalf("loading rows = %d, want 3", got)
	}
	if got := len(screen.Query("id:project-count-loading")); got != 1 {
		t.Fatalf("count loading = %d, want 1", got)
	}
	shot(screen, "49-project-loading")

	first := built.makeSession(sessionMeta{ID: "loading-a", Cwd: ws.Path, Title: "加载完成 A", Updated: time.Now()}, ws.Target)
	second := built.makeSession(sessionMeta{ID: "loading-b", Cwd: ws.Path, Title: "加载完成 B", Updated: time.Now().Add(-time.Minute)}, ws.Target)
	ws.Pi.Set([]*session{first, second})
	ws.PiLoading.Set(false)
	screen.Advance(250 * time.Millisecond)
	if got := len(screen.Query("id:session-row")); got != 2 {
		t.Fatalf("session rows = %d, want 2", got)
	}
	if got := projectSessionTotal(ws); got != 2 {
		t.Fatalf("project total = %d, want 2", got)
	}
}
