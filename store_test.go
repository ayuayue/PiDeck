package main

// Checks for copying a session into the app's own store.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDuplicateSession checks the copy has a new id, keeps the history
// and carries the name, while the original stays as it was.
func TestDuplicateSession(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "original.jsonl")
	body := `{"type":"session","version":3,"id":"old-id","timestamp":"2026-01-02T03:04:05Z","cwd":"C:/work"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-02T03:04:06Z","message":{"role":"user","content":"原来的提问"}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-02T03:04:07Z","message":{"role":"assistant","content":[{"type":"text","text":"原来的回答"}]}}
`
	if err := os.WriteFile(src, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	meta, err := st.duplicateSession(src, "new-id", "会话 副本")
	if err != nil {
		t.Fatal(err)
	}
	if meta.ID != "new-id" || meta.Title != "会话 副本" {
		t.Fatalf("meta = %+v", meta)
	}
	raw, err := os.ReadFile(meta.File)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	var head struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Cwd  string `json:"cwd"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &head); err != nil {
		t.Fatal(err)
	}
	if head.Type != "session" || head.ID != "new-id" || head.Cwd != "C:/work" {
		t.Fatalf("head = %+v", head)
	}
	if !strings.Contains(string(raw), "原来的提问") || !strings.Contains(string(raw), "原来的回答") {
		t.Fatalf("the copy lost the history: %s", raw)
	}
	orig, _ := os.ReadFile(src)
	if string(orig) != body {
		t.Fatal("the original session file changed")
	}
	// The copy lives under the app's own sessions directory.
	if !strings.HasPrefix(meta.File, st.sessions) {
		t.Fatalf("copy at %q, want under %q", meta.File, st.sessions)
	}
}

// TestDuplicateSessionRefusesGarbage checks a file that is not a pi
// session is not copied.
func TestDuplicateSessionRefusesGarbage(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "not-session.jsonl")
	if err := os.WriteFile(src, []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := st.duplicateSession(src, "new", ""); err == nil {
		t.Fatal("a non-session file was copied")
	}
}
