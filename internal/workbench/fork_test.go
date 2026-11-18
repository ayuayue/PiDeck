//go:build !js && !android && !ios

package workbench

// Checks for forking a session at a turn.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const forkSource = `{"type":"session","version":3,"id":"old","timestamp":"2026-06-01T10:00:00Z","cwd":"C:/work/shop"}
{"type":"message","id":"u1","timestamp":"2026-06-01T10:00:01Z","message":{"role":"user","content":"第一个提问"}}
{"type":"message","id":"a1","timestamp":"2026-06-01T10:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"第一个回答"}]}}
{"type":"message","id":"u2","timestamp":"2026-06-01T10:01:00Z","message":{"role":"user","content":"第二个提问"}}
{"type":"message","id":"a2","timestamp":"2026-06-01T10:01:01Z","message":{"role":"assistant","content":[{"type":"text","text":"第二个回答"}]}}
{"type":"message","id":"u3","timestamp":"2026-06-01T10:02:00Z","message":{"role":"user","content":"第三个提问"}}
`

// TestForkSession checks the copy keeps the history before the turn and
// returns the prompt that starts it.
func TestForkSession(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "source.jsonl")
	if err := os.WriteFile(src, []byte(forkSource), 0o644); err != nil {
		t.Fatal(err)
	}
	meta, prompt, err := st.forkSession(src, "new-id", 1, "会话 分叉")
	if err != nil {
		t.Fatal(err)
	}
	if meta.ID != "new-id" || meta.Title != "会话 分叉" {
		t.Fatalf("meta = %+v", meta)
	}
	if prompt != "第二个提问" {
		t.Fatalf("prompt = %q", prompt)
	}
	raw, err := os.ReadFile(meta.File)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, want := range []string{"第一个提问", "第一个回答", `"id":"new-id"`} {
		if !strings.Contains(text, want) {
			t.Errorf("fork lacks %q:\n%s", want, text)
		}
	}
	for _, not := range []string{"第二个提问", "第二个回答", "第三个提问"} {
		if strings.Contains(text, not) {
			t.Errorf("fork kept %q:\n%s", not, text)
		}
	}
	orig, _ := os.ReadFile(src)
	if string(orig) != forkSource {
		t.Fatal("the original session changed")
	}
}

// TestForkFirstTurn checks a fork at the first prompt is an empty session.
func TestForkFirstTurn(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "source.jsonl")
	if err := os.WriteFile(src, []byte(forkSource), 0o644); err != nil {
		t.Fatal(err)
	}
	meta, prompt, err := st.forkSession(src, "empty-id", 0, "空分叉")
	if err != nil {
		t.Fatal(err)
	}
	if prompt != "第一个提问" {
		t.Fatalf("prompt = %q", prompt)
	}
	raw, _ := os.ReadFile(meta.File)
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 { // header and session_info
		t.Fatalf("lines = %d:\n%s", len(lines), raw)
	}
	if strings.Contains(string(raw), "第一个回答") {
		t.Fatalf("the first answer stayed:\n%s", raw)
	}
}

// TestForkPastEnd checks a turn that does not exist is refused.
func TestForkPastEnd(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "source.jsonl")
	if err := os.WriteFile(src, []byte(forkSource), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.forkSession(src, "x", 9, ""); err == nil {
		t.Fatal("a turn past the end was forked")
	}
}
