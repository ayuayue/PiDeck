//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeLegacyFixture(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func legacyPiFixture(t *testing.T, path, id, cwd string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	header, _ := json.Marshal(map[string]any{"type": "session", "version": 3, "id": id, "cwd": cwd, "timestamp": "2026-06-01T10:00:00Z"})
	body := string(header) + "\n" + `{"type":"message","id":"u1","timestamp":"2026-06-01T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"migration fixture"}]}}` + "\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func setupLegacyFixture(t *testing.T) (string, string, string, string) {
	t.Helper()
	source, destination, sessions := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", sessions)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	chat := filepath.Join(source, "chat-workspace")
	path := filepath.Join(sessions, encodeCwd(chat), "old_native-1.jsonl")
	legacyPiFixture(t, path, "native-1", chat)
	writeLegacyFixture(t, filepath.Join(source, "projects.json"), map[string]any{"schemaVersion": 2, "revision": 1,
		"projects": []any{map[string]any{"id": "old-project", "kind": "chat", "name": "Old chat", "locator": map[string]any{
			"kind": "local", "environment": "windows", "localPath": chat}}}})
	writeLegacyFixture(t, filepath.Join(source, "session-catalog.json"), map[string]any{"version": 1, "sessions": []any{
		map[string]any{"id": "catalog-id", "projectId": "old-project", "piSessionId": "native-1", "title": "Saved title", "filePath": path, "mergedSessionIds": []string{"old-alias"}},
	}})
	writeLegacyFixture(t, filepath.Join(source, "settings.json"), map[string]any{"pinnedSessionIds": []string{"old-alias"}, "enhanceSystemPrompt": "Custom enhancement template"})
	writeLegacyFixture(t, filepath.Join(source, "quick-messages.json"), map[string]any{"version": 1, "items": []string{"Custom shortcut"}})
	if err := os.MkdirAll(chat, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(chat, "notes.md"), []byte("chat file"), 0o600); err != nil {
		t.Fatal(err)
	}
	return source, destination, sessions, path
}

func TestLegacyMigrationCopiesOwnedDataAndMapsIDs(t *testing.T) {
	source, destination, _, path := setupLegacyFixture(t)
	st, err := newStore(destination)
	if err != nil {
		t.Fatal(err)
	}
	var progress []sessionTransferState
	result := runLegacyMigration(context.Background(), st, source, func(s sessionTransferState) { progress = append(progress, s) })
	if result.Err != nil {
		t.Fatal(result.Err)
	}
	if result.Record.Imported != 1 || result.Record.Files != 1 || len(result.Sessions) != 1 {
		t.Fatalf("migration result = %+v, sessions = %d", result.Record, len(result.Sessions))
	}
	meta := result.Sessions[0]
	if meta.Cwd != filepath.Join(destination, "chat") || meta.ID != "native-1" {
		t.Fatalf("copied session = %+v", meta)
	}
	if result.Titles[meta.ID] != "Saved title" || len(result.Pinned) != 1 || result.Pinned[0] != meta.ID {
		t.Fatalf("metadata mapping = %v, %v", result.Titles, result.Pinned)
	}
	raw, _ := os.ReadFile(path)
	var original struct {
		Cwd string `json:"cwd"`
	}
	for i, b := range raw {
		if b == '\n' {
			raw = raw[:i]
			break
		}
	}
	if json.Unmarshal(raw, &original) != nil || original.Cwd != filepath.Join(source, "chat-workspace") {
		t.Fatal("source session changed")
	}
	chat, err := os.ReadFile(filepath.Join(destination, "chat", "notes.md"))
	if err != nil || string(chat) != "chat file" {
		t.Fatalf("chat file = %q, %v", chat, err)
	}
	shortcuts, err := readReplyShortcuts(destination)
	if err != nil || len(shortcuts.QuickMessages) != 1 || shortcuts.QuickMessages[0] != "Custom shortcut" {
		t.Fatalf("shortcuts = %+v, %v", shortcuts, err)
	}
	template, err := readPromptTemplate(destination)
	if err != nil || template != "Custom enhancement template" {
		t.Fatalf("template = %q, %v", template, err)
	}
	if len(progress) == 0 || progress[len(progress)-1].Done != progress[len(progress)-1].Total {
		t.Fatalf("progress did not finish: %+v", progress)
	}
	// The terminal marker must wait for the merged config to be saved.
	record, err := readLegacyMigration(destination)
	if err != nil || record.Status != "running" {
		t.Fatalf("premature completion = %+v, %v", record, err)
	}
}

func TestLegacyMigrationResumePreservesExistingData(t *testing.T) {
	source, destination, _, _ := setupLegacyFixture(t)
	st, err := newStore(destination)
	if err != nil {
		t.Fatal(err)
	}
	first := runLegacyMigration(context.Background(), st, source, func(sessionTransferState) {})
	if first.Err != nil {
		t.Fatal(first.Err)
	}
	if err := os.WriteFile(filepath.Join(destination, "chat", "notes.md"), []byte("new user content"), 0o600); err != nil {
		t.Fatal(err)
	}
	again := runLegacyMigration(context.Background(), st, source, func(sessionTransferState) {})
	if again.Err != nil || again.Record.Imported != 0 || again.Record.Skipped < 1 {
		t.Fatalf("resume = %+v, %v", again.Record, again.Err)
	}
	content, _ := os.ReadFile(filepath.Join(destination, "chat", "notes.md"))
	if string(content) != "new user content" {
		t.Fatal("resume overwrote the user's file")
	}
}

func TestLegacyMigrationSnapshotVersionsAndCustomChat(t *testing.T) {
	for _, version := range []int{1, 2} {
		t.Run(string(rune('0'+version)), func(t *testing.T) {
			source, destination, custom := t.TempDir(), t.TempDir(), t.TempDir()
			writeLegacyFixture(t, filepath.Join(source, "chat-path.json"), map[string]any{"path": custom})
			project := map[string]any{"id": "p", "name": "Custom chat", "kind": "chat"}
			if version == 1 {
				project["path"] = custom
			} else {
				project["locator"] = map[string]any{"kind": "local", "environment": "windows", "localPath": custom}
			}
			var projects any = []any{project}
			if version == 2 {
				projects = map[string]any{"schemaVersion": 2, "projects": projects}
			}
			writeLegacyFixture(t, filepath.Join(source, "projects.json"), projects)
			snapshot, err := readLegacySnapshot(source, destination)
			if err != nil {
				t.Fatal(err)
			}
			if len(snapshot.Projects) != 1 || snapshot.Projects[0].Path != custom || snapshot.Projects[0].Chat || len(snapshot.CwdMap) != 0 {
				t.Fatalf("external chat should stay in place: %+v", snapshot)
			}
		})
	}
}

func TestLegacyMigrationInvalidCatalogAndCancellation(t *testing.T) {
	source, destination, _, _ := setupLegacyFixture(t)
	st, err := newStore(destination)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "session-catalog.json"), []byte("broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := runLegacyMigration(context.Background(), st, source, func(sessionTransferState) {})
	if result.Err == nil || len(sessionFiles(st.sessions)) != 0 {
		t.Fatalf("invalid catalog was accepted: %+v", result)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result = runLegacyMigration(ctx, st, source, func(sessionTransferState) {})
	if result.Err != context.Canceled {
		t.Fatalf("cancel = %v", result.Err)
	}
}

func TestLegacyMigrationDiscoveryAndTerminalRecord(t *testing.T) {
	source, destination := t.TempDir(), t.TempDir()
	writeLegacyFixture(t, filepath.Join(source, "projects.json"), []any{})
	found, err := findLegacyMigrationSource([]string{destination, filepath.Join(destination, "nested"), source}, destination)
	if err != nil || found != source {
		t.Fatalf("source = %q, %v", found, err)
	}
	t.Setenv("PIDECK_V2_HOME", destination)
	t.Setenv("PIDECK_V2_LEGACY_HOME", "")
	if candidates := legacyMigrationCandidates(); len(candidates) != 0 {
		t.Fatalf("isolated home scans real profiles: %v", candidates)
	}
	record := legacyMigrationRecord{Version: 1, Status: "completed", Source: source, Imported: 3, Finished: time.Now().UTC()}
	if err := saveLegacyMigration(destination, record); err != nil {
		t.Fatal(err)
	}
	again, err := readLegacyMigration(destination)
	if err != nil || again.Status != "completed" || again.Imported != 3 {
		t.Fatalf("record = %+v, %v", again, err)
	}
	if err := os.WriteFile(filepath.Join(destination, legacyMigrationFile), []byte("broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readLegacyMigration(destination); err == nil {
		t.Fatal("accepted broken completion marker")
	}
}
