package main

// Checks for importing Codex and Claude sessions.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const codexSample = `{"timestamp":"2026-06-01T10:00:00Z","type":"session_meta","payload":{"id":"c1","cwd":"C:/work/x","timestamp":"2026-06-01T10:00:00Z"}}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"skip me"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"你好 Codex"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"你好，我在。"}]}}
`

const claudeSample = `{"type":"user","sessionId":"cl1","cwd":"C:/work/y","timestamp":"2026-06-01T10:00:00Z","message":{"role":"user","content":"问题一"}}
{"type":"assistant","sessionId":"cl1","cwd":"C:/work/y","timestamp":"2026-06-01T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"回答一"},{"type":"tool_use","id":"t1","name":"read"}]}}
{"type":"user","sessionId":"cl1","cwd":"C:/work/y","isSidechain":true,"timestamp":"2026-06-01T10:00:02Z","message":{"role":"user","content":"旁支"}}
{"type":"attachment","sessionId":"cl1","cwd":"C:/work/y","timestamp":"2026-06-01T10:00:03Z"}
`

// TestDetectSessionKind checks the three formats.
func TestDetectSessionKind(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	if got := detectSessionKind(write("pi.jsonl", `{"type":"session","id":"p1","cwd":"C:/w"}`+"\n")); got != kindPi {
		t.Errorf("pi = %q", got)
	}
	if got := detectSessionKind(write("codex.jsonl", codexSample)); got != kindCodex {
		t.Errorf("codex = %q", got)
	}
	if got := detectSessionKind(write("claude.jsonl", claudeSample)); got != kindClaude {
		t.Errorf("claude = %q", got)
	}
	if got := detectSessionKind(write("other.jsonl", "hello\n")); got != "" {
		t.Errorf("other = %q", got)
	}
}

// TestImportCodex checks the converted session.
func TestImportCodex(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "codex.jsonl")
	if err := os.WriteFile(src, []byte(codexSample), 0o644); err != nil {
		t.Fatal(err)
	}
	meta, err := st.importAnySession(src)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(meta.Title, "Codex · ") || filepath.Clean(meta.Cwd) != filepath.Clean("C:/work/x") {
		t.Fatalf("meta = %+v", meta)
	}
	raw, _ := os.ReadFile(meta.File)
	text := string(raw)
	for _, want := range []string{"你好 Codex", "你好，我在。", `"role":"user"`, `"role":"assistant"`} {
		if !strings.Contains(text, want) {
			t.Errorf("converted file lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "skip me") {
		t.Errorf("developer message was imported:\n%s", text)
	}
}

// TestImportClaude checks text blocks and that sidechains are skipped.
func TestImportClaude(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "claude.jsonl")
	if err := os.WriteFile(src, []byte(claudeSample), 0o644); err != nil {
		t.Fatal(err)
	}
	meta, err := st.importAnySession(src)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(meta.Title, "Claude · ") || filepath.Clean(meta.Cwd) != filepath.Clean("C:/work/y") {
		t.Fatalf("meta = %+v", meta)
	}
	raw, _ := os.ReadFile(meta.File)
	text := string(raw)
	for _, want := range []string{"问题一", "回答一"} {
		if !strings.Contains(text, want) {
			t.Errorf("converted file lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "旁支") {
		t.Errorf("sidechain was imported:\n%s", text)
	}
}
