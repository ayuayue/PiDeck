package main

// Checks for the global session search: indexing, matching and opening.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

// searchSession builds one session file with a title and two messages.
func searchSession(id, cwd, name, prompt string) string {
	head := `{"type":"session","version":3,"id":"` + id + `","timestamp":"2026-06-01T10:00:00Z","cwd":"` + filepath.ToSlash(cwd) + `"}
`
	if name != "" {
		head += `{"type":"session_info","name":"` + name + `","timestamp":"2026-06-01T10:00:00Z"}
`
	}
	head += `{"type":"message","id":"u1","timestamp":"2026-06-01T10:00:01Z","message":{"role":"user","content":"` + prompt + `"}}
{"type":"message","id":"a1","timestamp":"2026-06-01T10:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"回答：` + prompt + `"}]}}
`
	return head
}

// TestSearchIndexAndMatch checks titles and text are both searched.
func TestSearchIndexAndMatch(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.jsonl", searchSession("a", "C:/work/shop", "部署手册", "怎么发布到生产环境"))
	write("b.jsonl", searchSession("b", "C:/work/blog", "", "写一篇关于并发编程的文章"))
	write("c.jsonl", searchSession("c", "C:/work/other", "无关会话", "今天天气不错"))
	docs := buildSearchIndex([]string{dir}, "")
	if len(docs) != 3 {
		t.Fatalf("docs = %d", len(docs))
	}
	hits := matchSearch(docs, "并发", 10)
	if len(hits) != 1 || hits[0].ID != "b" {
		t.Fatalf("text hits = %+v", hits)
	}
	if !strings.Contains(hits[0].Snippet, "并发") {
		t.Fatalf("snippet = %q", hits[0].Snippet)
	}
	hits = matchSearch(docs, "部署", 10)
	if len(hits) != 1 || hits[0].ID != "a" || !hits[0].InTitle {
		t.Fatalf("title hits = %+v", hits)
	}
	if got := matchSearch(docs, "不存在", 10); len(got) != 0 {
		t.Fatalf("no-match = %+v", got)
	}
}

// TestSearchOpensSession checks a result opens its session.
func TestSearchOpensSession(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	dir := filepath.Join(home, "sessions", "--x--")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "s.jsonl"),
		[]byte(searchSession("s-1", workspace, "部署手册", "怎么发布到生产环境")), 0o644); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Key("mod+shift+f")
	app.WaitFor("id:session-search", 10*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("text:索引里有 1 个会话")) > 0 })
	app.Type("id:search-input", "部署")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:search-hit")) > 0 })
	app.Press("id:search-hit")
	app.WaitForGone("id:session-search", 5*time.Second)
	app.WaitFor("id:composer", 10*time.Second)
}

// TestSearchIndexNested checks the app's own nested session layout.
func TestSearchIndexNested(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "sessions", "--x--")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "s.jsonl"),
		[]byte(searchSession("s-1", `C:\work\shop`, "部署手册", "怎么发布到生产环境")), 0o644); err != nil {
		t.Fatal(err)
	}
	docs := buildSearchIndex([]string{filepath.Join(home, "sessions")}, "")
	t.Logf("docs = %+v", docs)
	hits := matchSearch(docs, "部署", 10)
	if len(hits) != 1 {
		t.Fatalf("hits = %+v", hits)
	}
}

// TestSearchACPDocs checks archived ACP transcripts are searchable.
func TestSearchACPDocs(t *testing.T) {
	dir := t.TempDir()
	arch := acpArchive{ID: "acp-1", Title: "ACP 会话", Cwd: "C:/work/z",
		Turns: []turn{{Prompt: "问 ACP", Final: "ACP 回答"}}}
	raw, err := json.Marshal(arch)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "acp-1.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	docs := buildACPSearchDocs(dir)
	if len(docs) != 1 || docs[0].ID != "acp-1" || !strings.Contains(docs[0].Text, "ACP 回答") {
		t.Fatalf("docs = %+v", docs)
	}
	hits := matchSearch(docs, "ACP", 10)
	if len(hits) != 1 || hits[0].ID != "acp-1" {
		t.Fatalf("hits = %+v", hits)
	}
}
