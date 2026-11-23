//go:build !js && !android && !ios

package workbench

// Checks for the global session search: indexing, matching and opening.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// searchSession builds one session file with a title and two messages.
func searchSession(id, cwd, name, prompt string) string {
	// A Windows path holds backslashes, which JSON needs escaped: writing it
	// raw made the whole session line unreadable off Windows.
	quoted, err := json.Marshal(filepath.ToSlash(cwd))
	if err != nil {
		panic(err)
	}
	head := `{"type":"session","version":3,"id":"` + id + `","timestamp":"2026-06-01T10:00:00Z","cwd":` + string(quoted) + `}
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
	hits := matchSearch(t.Context(), docs, "并发", 10)
	if len(hits) != 1 || hits[0].ID != "b" {
		t.Fatalf("text hits = %+v", hits)
	}
	if !strings.Contains(hits[0].Snippet, "并发") {
		t.Fatalf("snippet = %q", hits[0].Snippet)
	}
	hits = matchSearch(t.Context(), docs, "部署", 10)
	if len(hits) != 1 || hits[0].ID != "a" || !hits[0].InTitle {
		t.Fatalf("title hits = %+v", hits)
	}
	if got := matchSearch(t.Context(), docs, "不存在", 10); len(got) != 0 {
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
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	dir := filepath.Join(home, "sessions", "--x--")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "s.jsonl"),
		[]byte(searchSession("s-1", workspace, "部署手册", "怎么发布到生产环境")), 0o644); err != nil {
		t.Fatal(err)
	}
	var a *app
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		return a.view()
	}, nsgotest.Size(1200, 800))
	app.Key("mod+f")
	app.WaitFor("id:session-search", 10*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("text:索引里有 1 个会话")) > 0 })
	app.Type("id:search-input", "部署")
	app.Advance(searchDebounce)
	app.WaitUntil(5*time.Second, func() bool { return a.searchResults.GetUntracked() != nil })
	if got := a.searchResults.GetUntracked(); len(got.hits) != 1 || got.hits[0].ID != "s-1" {
		t.Fatalf("search result = %+v, want only s-1", got)
	}
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:search-hit")) > 0 })
	app.Press("id:search-hit")
	app.WaitForGone("id:session-search", 5*time.Second)
	app.WaitFor("id:composer", 10*time.Second)

	// The query is remembered, and a chip searches again.
	app.Key("mod+f")
	app.WaitFor("id:session-search", 10*time.Second)
	app.WaitFor("text:最近搜索", 5*time.Second)
	app.Press("role:button 最近搜索 部署")
	app.Advance(searchDebounce)
	app.WaitUntil(5*time.Second, func() bool { return a.searchResults.GetUntracked() != nil })
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:search-hit")) > 0 })
	app.Clear("id:search-input")
	app.WaitFor("text:最近搜索", 5*time.Second)
	app.Press("id:search-clear-recent")
	app.WaitForGone("text:最近搜索", 5*time.Second)
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
	hits := matchSearch(t.Context(), docs, "部署", 10)
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
	hits := matchSearch(t.Context(), docs, "ACP", 10)
	if len(hits) != 1 || hits[0].ID != "acp-1" {
		t.Fatalf("hits = %+v", hits)
	}
}

// TestSearchScope filters results by title or body.
func TestSearchScope(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	dir := filepath.Join(home, "sessions", "--x--")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.jsonl"),
		[]byte(searchSession("s-1", workspace, "部署手册", "怎么发布到生产环境")), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.jsonl"),
		[]byte(searchSession("s-2", workspace, "发布记录", "这次部署踩了两个坑")), 0o644); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Key("mod+f")
	app.WaitFor("id:session-search", 10*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("text:索引里有 2 个会话")) > 0 })
	app.Type("id:search-input", "部署")
	app.Advance(searchDebounce)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:search-hit")) == 2 })
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:找到 2 个会话 · 2 处匹配")) > 0 })
	app.Press("role:radio 标题")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:search-hit")) == 1 })
	app.Press("role:radio 正文")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:search-hit")) == 1 })
	app.Press("role:radio 全部")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:search-hit")) == 2 })
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:找到 2 个会话 · 2 处匹配")) > 0 })
}

// TestSearchEnterOpensFirst opens the first result with Enter.
func TestSearchEnterOpensFirst(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	t.Setenv("PIDECK_V2_HOME", home)
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
	app.Key("mod+f")
	app.WaitFor("id:session-search", 10*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("text:索引里有 1 个会话")) > 0 })
	app.Type("id:search-input", "部署")
	app.Advance(searchDebounce)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:search-hit")) > 0 })
	app.Submit("id:search-input")
	app.WaitForGone("id:session-search", 5*time.Second)
	app.WaitFor("id:composer", 10*time.Second)
	app.WaitFor("id:tab >> text:部署手册", 10*time.Second)
}

func TestSearchEnterUsesCurrentQuery(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	a, screen := startSearchDialog(t)
	screen.Type("id:search-input", "alpha")
	screen.Post(a.runSearch)
	screen.WaitFor("id:search-hit >> text:alpha", 5*time.Second)
	screen.Clear("id:search-input")
	screen.Type("id:search-input", "beta")
	if hits := screen.Query("id:search-hit"); len(hits) != 0 {
		t.Fatalf("previous query still shows %d results while beta is pending", len(hits))
	}
	screen.Submit("id:search-input")
	screen.WaitFor("text:没有匹配的会话", 5*time.Second)
	if got := a.searchResults.GetUntracked(); got == nil || got.query != "beta" || len(got.hits) != 0 {
		t.Fatalf("submit used results %+v, want a fresh empty beta result", got)
	}
}

func TestSearchRecentClearSurvivesResultRefresh(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	a, screen := startSearchDialog(t)
	screen.Post(func() { a.rememberSearch("alpha") })
	screen.Type("id:search-input", "alpha")
	screen.Post(a.runSearch)
	screen.WaitFor("id:search-hit >> text:alpha", 5*time.Second)
	screen.Clear("id:search-input")
	button := screen.Find("id:search-clear-recent").ID
	// The previous query may still refresh as the user moves to Clear.
	previous := &searchResult{query: "alpha", hits: []searchHit{{ID: "alpha", Title: "alpha"}}}
	screen.Post(func() { a.searchResults.Set(previous) })
	if got := screen.Find("id:search-clear-recent").ID; got != button {
		t.Fatalf("refresh replaced the pressed Clear button: got %v, want %v", got, button)
	}
	screen.Press("id:search-clear-recent")
	screen.WaitForGone("text:最近搜索", 5*time.Second)
}

func startSearchDialog(t *testing.T) (*app, *nsgotest.App) {
	t.Helper()
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		a.searchDocs = append(a.searchDocs, searchDoc{ID: "alpha", Title: "alpha"})
		a.searchIndexed = true
		a.openSearch()
		return a.searchDialog()
	}, nsgotest.Size(1200, 800))
	screen.WaitFor("id:session-search", 5*time.Second)
	return a, screen
}
