//go:build !js && !android && !ios

package workbench

// Checks the transcript read from a session file: the parse cache, the tab
// that paints from it before pi answers, and the replacement when pi's copy
// is the one that counts.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// historyFile writes a session file with one exchange per prompt.
func historyFile(t *testing.T, prompts ...string) string {
	t.Helper()
	body := `{"type":"session","version":3,"id":"from-file","timestamp":"2026-06-01T10:00:00Z","cwd":"C:/work"}` + "\n"
	for i, p := range prompts {
		body += fmt.Sprintf(`{"type":"message","id":"u%d","timestamp":"2026-06-01T10:00:01Z","message":{"role":"user","content":"%s"}}`, i, p) + "\n"
		body += fmt.Sprintf(`{"type":"message","id":"a%d","timestamp":"2026-06-01T10:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"回答：%s"}]}}`, i, p) + "\n"
	}
	path := filepath.Join(t.TempDir(), "history.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestSessionFileMessagesCache reads a file once, and again once it grows.
func TestSessionFileMessagesCache(t *testing.T) {
	path := historyFile(t, "第一条", "第二条")
	first, err := sessionFileMessages(path)
	if err != nil || len(first) != 4 {
		t.Fatalf("first read = %d messages, %v; want 4", len(first), err)
	}
	again, err := sessionFileMessages(path)
	if err != nil || len(again) != 4 {
		t.Fatalf("second read = %d messages, %v; want 4", len(again), err)
	}
	if &again[0] != &first[0] {
		t.Fatal("an unchanged file was parsed again")
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"type":"message","id":"u9","message":{"role":"user","content":"新的一条"}}` + "\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()
	grown, err := sessionFileMessages(path)
	if err != nil || len(grown) != 5 {
		t.Fatalf("read after an append = %d messages, %v; want 5", len(grown), err)
	}
	if &grown[0] == &first[0] {
		t.Fatal("a changed file came from the cache")
	}
	if got := grown[4].text(); got != "新的一条" {
		t.Fatalf("appended message = %q", got)
	}
	// The parse kept its place, so the next append reads only its own bytes.
	entry, ok := sessionHistory.previous(path)
	if !ok {
		t.Fatal("the parse was not kept")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if entry.tail.Consumed != info.Size() {
		t.Fatalf("parse covers %d of %d bytes", entry.tail.Consumed, info.Size())
	}
}

// TestSessionPaintsFromFile fills a tab's transcript from the session file,
// then lets pi's copy replace it.
func TestSessionPaintsFromFile(t *testing.T) {
	home := t.TempDir()
	workspace := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "FileProject"}},
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
	file := historyFile(t, "部署手册", "怎么回滚")
	s := built.makeSession(sessionMeta{ID: "from-file", Cwd: ws.Path, File: file, Title: "文件秒开", Updated: time.Now()}, ws.Target)
	built.activeID.Set(s.ID)
	built.activeWS.Set(ws.Path)

	built.loadHistoryFromFile(s)
	screen.WaitUntil(5*time.Second, func() bool { return s.loaded.GetUntracked() })
	if got := len(s.turns.GetUntracked()); got != 2 {
		t.Fatalf("turns painted from the file = %d, want 2", got)
	}
	if s.histFile != 4 {
		t.Fatalf("histFile = %d, want the file's 4 messages", s.histFile)
	}

	// A session pi rewrote - a compacted one - takes pi's copy instead, and
	// the file's count stops standing in for it.
	built.historyFromPi(s, turnsFromMessages([]piMessage{{Role: "user"}}), nil)
	if got := len(s.turns.GetUntracked()); got != 1 {
		t.Fatalf("turns after pi's copy = %d, want 1", got)
	}
	if s.histFile != 0 {
		t.Fatalf("histFile after pi's copy = %d, want 0", s.histFile)
	}
}

// TestSessionFileKeepsHowLongACallTook reads the times pi records on the
// messages themselves: the run of a call, and what its message took before it
// acted. The entry times deliberately are not the answer, since pi writes them
// where the messages land rather than where they began.
func TestSessionFileKeepsHowLongACallTook(t *testing.T) {
	body := strings.Join([]string{
		`{"type":"session","version":3,"id":"timed","timestamp":"2026-06-01T10:00:00Z","cwd":"C:/work"}`,
		`{"type":"message","id":"u1","timestamp":"2026-06-01T10:00:01Z","message":{"role":"user","content":"跑测试"}}`,
		`{"type":"message","id":"a1","timestamp":"2026-06-01T10:00:02Z","message":{"role":"assistant","durationMs":1500,"content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"go test ./..."}}]}}`,
		`{"type":"message","id":"r1","timestamp":"2026-06-01T10:00:06Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","durationMs":4000,"content":[{"type":"text","text":"ok"}]}}`,
	}, "\n") + "\n"
	path := filepath.Join(t.TempDir(), "timed.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	msgs, err := sessionFileMessages(path)
	if err != nil {
		t.Fatal(err)
	}
	turns := turnsFromMessages(msgs)
	if len(turns) != 1 || len(turns[0].Steps) != 1 || len(turns[0].Steps[0].Tools) != 1 {
		t.Fatalf("turns = %+v, want one call", turns)
	}
	if got := turns[0].Steps[0].Tools[0].DurationMs; got != 4000 {
		t.Fatalf("the call's time = %d ms, want the 4000 ms pi recorded on its result", got)
	}
	if got := turns[0].Steps[0].Think; got != 1500*time.Millisecond {
		t.Fatalf("the thought's time = %v, want the 1500 ms pi recorded on the message", got)
	}
}
