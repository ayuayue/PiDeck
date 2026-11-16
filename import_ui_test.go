package main

// Checks the import dialog end to end: a scan of another agent's store
// becomes rows, picking one and running the import writes a pi session,
// puts the project in the rail, and shows the row as imported.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestImportDialogImportsSelection drives the dialog with one Claude
// session and checks where it lands.
func TestImportDialogImportsSelection(t *testing.T) {
	home := t.TempDir()
	proj := t.TempDir()
	store := t.TempDir()
	empty := t.TempDir()
	for _, key := range []string{"qoder", "codex", "cursor", "kimi", "minimax", "zcode", "opencode", "workbuddy", "codebuddy"} {
		t.Setenv("PIDECK_LITE_IMPORT_"+strings.ToUpper(key)+"_DIR", empty)
	}
	t.Setenv("APPDATA", t.TempDir()) // Kimi Work's share folder is found there
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_IMPORT_CLAUDE_DIR", store)
	dir := filepath.Join(store, "C--work-proj--")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"type":"user","sessionId":"s1","cwd":"` + filepath.ToSlash(proj) + `","uuid":"u1","timestamp":"2026-06-01T10:00:00Z","message":{"role":"user","content":"来自 Claude 的问题"}}` + "\n" +
		`{"type":"assistant","sessionId":"s1","cwd":"` + filepath.ToSlash(proj) + `","uuid":"a1","parentUuid":"u1","timestamp":"2026-06-01T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"来自 Claude 的回答"}]}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "s1.jsonl"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	var built *app
	root := func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}
	app := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	app.Settle()

	app.Press("text:导入会话")
	app.WaitFor("id:import-dialog", 5*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:import-row")) == 1 })

	app.Press("id:import-select-all")
	app.Press("id:import-run")
	// The dialog shows the run's progress, then the row stands imported.
	app.WaitUntil(15*time.Second, func() bool {
		if built == nil {
			return false
		}
		rows := built.impRows.GetUntracked()
		return len(rows) == 1 && rows[0].State == importCurrent
	})

	target := filepath.Join(home, "sessions", encodeCwd(proj), "claude_s1.jsonl")
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("the imported file is not where it belongs: %v", err)
	}
	msgs, err := sessionFileMessages(target)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("imported messages = %d, want 2", len(msgs))
	}
	// The project came onto the rail with the session under it.
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:project-row")) == 1 })
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:session-row")) == 1 })
	app.Settle()
	if built != nil {
		if ws := built.workspaceOf(proj); ws == nil {
			t.Fatal("the imported session's project is not on the rail")
		}
	}
	// A second scan finds it already imported.
	app.Press("id:import-rescan")
	app.WaitUntil(10*time.Second, func() bool {
		rows := built.impRows.GetUntracked()
		return len(rows) == 1 && rows[0].State == importCurrent
	})
}
