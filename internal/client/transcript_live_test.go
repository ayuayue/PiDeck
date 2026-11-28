package client

// A running turn on the phone draws what the desktop draws: the process in
// the open, one line of the newest thinking, a row per tool call, and the
// line that says pi is still working. A finished turn folds it all away.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// liveTranscriptDesktop serves one session whose transcript the test can
// swap between a running turn and a finished one.
func liveTranscriptDesktop(t *testing.T, transcript func() remotewire.Transcript) (*nsgotest.App, *mobileApp) {
	t.Helper()
	const token = "live-token"
	state := remotewire.Snapshot{Name: "PiDeck", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{{ID: "s1", Title: "正在跑的会话", Running: true}},
	}}}
	mux := http.NewServeMux()
	check := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "PiDeck", "host": "desk"})
		}
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(state)
		}
	})
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(transcript())
		}
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var built *mobileApp
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newMobileApp(cx)
		return built.view()
	}, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-server", 10*time.Second)
	app.Type("id:mobile-server", server.URL)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")
	waitApp(app, "text:电脑项目", 15*time.Second)
	openPhoneRail(app)
	app.WaitFor("id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	return app, built
}

// runningTranscript is one turn pi is still on: a folded thought, a tool
// call at work and the prose that has arrived so far.
func runningTranscript() remotewire.Transcript {
	thinking := "先用 git status 看一眼工作区，再决定要不要动 index.go 里的接口；" +
		strings.Repeat("顺便把这条思路写长一点，让一行放不下。", 12)
	return remotewire.Transcript{ID: "s1", Title: "正在跑的会话", Running: true,
		Messages: []remotewire.Message{
			{Role: "user", Text: "改一下接口", Turn: 0},
			{Role: "thinking", Text: thinking, Turn: 0},
			{Role: "tool", Text: "运行 git status", Turn: 0, Tool: &remotewire.ToolLine{
				Name: "bash", Action: "运行", Detail: "git status", Status: "running"}},
			{Role: "assistant", Text: "先看一下工作区，", Turn: 0},
		}}
}

// finishedTranscript is the same turn, done: the process folds and the
// answer stands on its own.
func finishedTranscript() remotewire.Transcript {
	done := runningTranscript()
	done.Running = false
	done.Messages = []remotewire.Message{
		{Role: "user", Text: "改一下接口", Turn: 0},
		{Role: "thinking", Text: "先看一眼工作区再说。", Turn: 0},
		{Role: "tool", Text: "运行 git status", Turn: 0, Tool: &remotewire.ToolLine{
			Name: "bash", Action: "运行", Detail: "git status", Status: "done",
			DurationMs: 120, Output: "On branch main\nnothing to commit"}},
		{Role: "tool", Text: "读取 index.go", Turn: 0, Tool: &remotewire.ToolLine{
			Name: "read", Action: "读取", Detail: "index.go", Status: "done", DurationMs: 8}},
		{Role: "assistant", Text: "接口改好了，测试也过了。", Turn: 0},
	}
	return done
}

func TestMobileRunningTurnStaysOpen(t *testing.T) {
	app, _ := liveTranscriptDesktop(t, runningTranscript)
	waitApp(app, "text:先看一下工作区，", 15*time.Second)
	// The thinking shows as one line of its newest words, not a block.
	thoughts := app.Query("id:mobile-thought")
	if len(thoughts) != 1 {
		t.Fatalf("thinking rows = %d; want 1 while running", len(thoughts))
	}
	var shown string
	for _, v := range app.Query("id:mobile-thought >> tview") {
		shown += v.Text
	}
	if strings.Contains(shown, "\n") {
		t.Fatalf("the running thought took more than one line: %q", shown)
	}
	if len(app.Query("id:mobile-thought-more")) != 0 {
		t.Fatal("a running thought asked to be expanded")
	}
	// The call is its own row, at work, and the process is not folded.
	app.WaitFor("id:mobile-tool-row", 5*time.Second)
	app.WaitFor("id:mobile-working", 5*time.Second)
	if len(app.Query("id:mobile-process")) != 0 {
		t.Fatal("a running turn folded its process")
	}
	shot(app, "67-mobile-running")
}

func TestMobileFinishedTurnFoldsProcess(t *testing.T) {
	done := false
	app, _ := liveTranscriptDesktop(t, func() remotewire.Transcript {
		if done {
			return finishedTranscript()
		}
		return runningTranscript()
	})
	waitApp(app, "text:先看一下工作区，", 15*time.Second)
	done = true
	// The next poll ends the turn: the loop runs on the app clock, so
	// the wait moves it.
	waitFor(t, app, 20*time.Second, func() bool {
		app.Advance(1200 * time.Millisecond)
		return len(app.Query("text:接口改好了，测试也过了。")) > 0
	})
	app.WaitFor("id:mobile-process", 10*time.Second)
	if len(app.Query("id:mobile-tool-row")) != 0 {
		t.Fatal("a finished turn kept its tool rows in the open")
	}
	app.Press("id:mobile-process")
	waitFor(t, app, 10*time.Second, func() bool {
		n := len(app.Query("id:mobile-tool-row"))
		return n > 0
	})
	app.Press("id:mobile-tool-row >> nth=0")
	waitApp(app, "text:On branch main", 5*time.Second)
	shot(app, "68-mobile-folded-process")
}

// TestMobileToolDiffDrawsAsPatch guards what a change touched: the desktop
// sends it as a patch, and the phone opens it as one rather than as lines of
// plain text.
func TestMobileToolDiffDrawsAsPatch(t *testing.T) {
	app, _ := liveTranscriptDesktop(t, func() remotewire.Transcript {
		return remotewire.Transcript{ID: "s1", Title: "正在跑的会话", Running: true,
			Messages: []remotewire.Message{
				{Role: "user", Text: "改一下接口", Turn: 0},
				{Role: "tool", Text: "编辑 index.go", Turn: 0, Tool: &remotewire.ToolLine{
					Name: "edit", Action: "编辑", Detail: "index.go", Status: "done", DurationMs: 30, Diff: true,
					Output: "diff --git a/index.go b/index.go\n--- a/index.go\n+++ b/index.go\n@@ -1 +1 @@\n-old line\n+new line\n"}},
			}}
	})
	app.WaitFor("id:mobile-tool-row", 10*time.Second)
	app.Press("id:mobile-tool-row")
	app.WaitFor("id:mobile-tool-diff", 5*time.Second)
	app.WaitUntil(5*time.Second, func() bool {
		return len(app.Query("text:new line")) > 0 && len(app.Query("text:old line")) > 0
	})
}
