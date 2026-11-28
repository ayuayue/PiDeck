//go:build !js && !android && !ios

package workbench

// Checks the import dialog end to end: a scan of another agent's store
// becomes rows, picking one and running the import writes a pi session,
// puts the project in the rail, and shows the row as imported.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/sessionimport"
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
		t.Setenv("PIDECK_V2_IMPORT_"+strings.ToUpper(key)+"_DIR", empty)
	}
	t.Setenv("APPDATA", t.TempDir()) // Kimi Work's share folder is found there
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_IMPORT_CLAUDE_DIR", store)
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
		return len(rows) == 1 && rows[0].State == sessionimport.Current
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
		return len(rows) == 1 && rows[0].State == sessionimport.Current
	})
}

// TestImportDialogFromProjectImportsThere checks that a project's dialog
// lists and imports only that project's sessions across sources.
func TestImportDialogFromProjectImportsThere(t *testing.T) {
	home := t.TempDir()
	proj := t.TempDir()
	elsewhere := t.TempDir()
	empty := t.TempDir()
	for _, key := range []string{"qoder", "cursor", "kimi", "minimax", "zcode", "opencode", "workbuddy", "codebuddy"} {
		t.Setenv("PIDECK_V2_IMPORT_"+strings.ToUpper(key)+"_DIR", empty)
	}
	t.Setenv("APPDATA", t.TempDir())

	claudeDir := t.TempDir()
	t.Setenv("PIDECK_V2_IMPORT_CLAUDE_DIR", claudeDir)
	head := `{"type":"user","sessionId":"c1","cwd":"` + filepath.ToSlash(proj) + `","uuid":"u1","timestamp":"2026-06-01T10:00:00Z","message":{"role":"user","content":"本项目的 Claude 会话"}}` + "\n"
	if err := os.WriteFile(filepath.Join(claudeDir, "c1.jsonl"), []byte(head), 0o644); err != nil {
		t.Fatal(err)
	}
	codexDir := t.TempDir()
	t.Setenv("PIDECK_V2_IMPORT_CODEX_DIR", codexDir)
	rollout := `{"timestamp":"2026-06-01T10:00:00Z","type":"session_meta","payload":{"id":"x1","cwd":"` + filepath.ToSlash(proj) + `"}}` + "\n" +
		`{"timestamp":"2026-06-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Codex 的会话"}]}}` + "\n"
	if err := os.WriteFile(filepath.Join(codexDir, "rollout-x1.jsonl"), []byte(rollout), 0o644); err != nil {
		t.Fatal(err)
	}
	foreign := strings.ReplaceAll(strings.ReplaceAll(head, "c1", "c2"), filepath.ToSlash(proj), filepath.ToSlash(elsewhere))
	if err := os.WriteFile(filepath.Join(claudeDir, "c2.jsonl"), []byte(foreign), 0o644); err != nil {
		t.Fatal(err)
	}
	unknown := strings.ReplaceAll(strings.ReplaceAll(rollout, "x1", "x3"), filepath.ToSlash(proj), "")
	if err := os.WriteFile(filepath.Join(codexDir, "rollout-x3.jsonl"), []byte(unknown), 0o644); err != nil {
		t.Fatal(err)
	}
	foreignRollout := strings.ReplaceAll(strings.ReplaceAll(rollout, "x1", "x2"), filepath.ToSlash(proj), filepath.ToSlash(elsewhere))
	if err := os.WriteFile(filepath.Join(codexDir, "rollout-x2.jsonl"), []byte(foreignRollout), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PIDECK_V2_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Theme: "system", SidebarOpen: true,
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
	app := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	app.Settle()
	if built == nil {
		t.Fatal("the app was not built")
	}
	ws := built.workspaceOf(proj)
	if ws == nil {
		t.Fatal("the project is not on the rail")
	}
	built.openImportDialogFor(ws)
	app.WaitFor("id:import-dialog", 5*time.Second)
	app.WaitUntil(10*time.Second, func() bool {
		return !built.impScanning.GetUntracked() && len(app.Query("id:import-row")) == 2
	})
	if app.Exists("id:import-target-original") {
		t.Fatal("the project dialog offers to switch to a global import")
	}
	for _, row := range built.impRows.GetUntracked() {
		if pathKey(row.Cwd) != pathKey(proj) {
			t.Fatalf("the project scan loaded a session from %q", row.Cwd)
		}
	}

	// One tab per source, and each shows only its own sessions.
	for _, id := range []string{"import-tab-all", "import-tab-claude", "import-tab-codex"} {
		if len(app.Query("id:"+id)) == 0 {
			t.Fatalf("the dialog has no %s", id)
		}
	}
	app.Press("id:import-tab-claude")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:import-row")) == 1 })
	app.Press("id:import-tab-codex")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:import-row")) == 1 })
	app.Press("id:import-tab-all")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:import-row")) == 2 })

	app.Press("id:import-select-all")
	app.Press("id:import-run")
	app.WaitUntil(20*time.Second, func() bool {
		rows := built.impRows.GetUntracked()
		if len(rows) != 2 {
			return false
		}
		for _, row := range rows {
			if row.State != sessionimport.Current {
				return false
			}
		}
		return true
	})

	// Every picked session belongs to this project.
	dir := filepath.Join(home, "sessions", encodeCwd(proj))
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("the project's session folder: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("imported files = %d, want 2 in %s", len(entries), dir)
	}
	for _, e := range entries {
		path := filepath.Join(dir, e.Name())
		head, ok := sessionimport.ReadSessionHead(path)
		if !ok {
			t.Fatalf("%s has no session header", e.Name())
		}
		if pathKey(head.Cwd) != pathKey(proj) {
			t.Fatalf("%s was written for %q, want the project", e.Name(), head.Cwd)
		}
	}
	// A rescan keeps the same scope, including imported sessions.
	app.Press("id:import-rescan")
	app.WaitUntil(10*time.Second, func() bool {
		return !built.impScanning.GetUntracked() && len(built.impRows.GetUntracked()) == 2
	})

	// The global entry still lists every project, then reopening a project
	// discards those cached rows and any scan still running for that scope.
	app.Post(func() { built.openImportDialog() })
	app.WaitUntil(10*time.Second, func() bool {
		return !built.impScanning.GetUntracked() && len(built.impRows.GetUntracked()) == 5
	})
	app.Post(func() {
		built.scanImports()
		built.openImportDialogFor(ws)
		if rows := built.impRows.GetUntracked(); len(rows) != 0 {
			t.Errorf("reopening a project retained %d global rows", len(rows))
		}
	})
	app.WaitUntil(10*time.Second, func() bool {
		return !built.impScanning.GetUntracked() && len(built.impRows.GetUntracked()) == 2
	})

	// No matching sessions means an empty list, not a global fallback.
	emptyProject := t.TempDir()
	app.Post(func() { built.openImportDialogFor(&workspace{Path: emptyProject, Target: localTarget}) })
	app.WaitUntil(10*time.Second, func() bool { return !built.impScanning.GetUntracked() })
	if rows := built.impRows.GetUntracked(); len(rows) != 0 {
		t.Fatalf("an empty project loaded %d sessions", len(rows))
	}

	// The welcome dialog's own path still imports where a session ran.
	built.impProject.Set("")
	if got := built.importCwdFor(sessionimport.Candidate{Source: "claude", Cwd: elsewhere}); pathKey(got) != pathKey(elsewhere) {
		t.Fatalf("without a project the import goes to %q, want %q", got, elsewhere)
	}
}
