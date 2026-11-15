package main

// Checks the local HTML export.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestRenderSessionHTML checks content is escaped and the turn is drawn.
func TestRenderSessionHTML(t *testing.T) {
	page := renderSessionHTML(exportData{
		Title:   "测试会话",
		Project: "C:/work/shop",
		Model:   "acme/one",
		When:    time.Date(2026, 6, 1, 10, 0, 0, 0, time.Local),
		Turns: []turn{{
			Prompt: `<script>alert("x")</script>`,
			Steps: []turnStep{{
				Thinking: "想一想",
				Text:     "第一段",
				Tools:    []toolRun{{Action: "运行", Detail: "go test", Output: "ok", Status: 2}},
			}},
			Final: "最后回答",
		}},
	})
	for _, want := range []string{"测试会话", "C:/work/shop", "第一段", "最后回答", "go test", "想一想"} {
		if !strings.Contains(page, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	if strings.Contains(page, `<script>alert`) {
		t.Fatal("the prompt was not escaped")
	}
	if !strings.Contains(page, "&lt;script&gt;") {
		t.Fatal("the escaped prompt is missing")
	}
}

// TestSanitizeFileName checks path characters are replaced.
func TestSanitizeFileName(t *testing.T) {
	if got := sanitizeFileName(`a/b\c:d*e?f"g<h>i|j`); strings.ContainsAny(got, `/\:*?"<>|`) {
		t.Fatalf("name = %q", got)
	}
	if got := sanitizeFileName("   "); got != "session" {
		t.Fatalf("blank = %q", got)
	}
}

// TestRenderSessionMarkdown checks the Markdown export keeps the turn and
// lengthens the fence around a prompt that has backticks.
func TestRenderSessionMarkdown(t *testing.T) {
	md := renderSessionMarkdown(exportData{
		Title:   "测试会话",
		Project: "C:/work/shop",
		Model:   "acme/one",
		When:    time.Date(2026, 6, 1, 10, 0, 0, 0, time.Local),
		Turns: []turn{{
			Prompt: "写 `code` 和 ```fence```",
			Steps: []turnStep{{
				Tools: []toolRun{{Action: "编辑", Detail: "a.go", Added: 2, Removed: 1, Status: 2}},
			}},
			Final: "最终回答",
		}},
	})
	for _, want := range []string{"# 测试会话", "## 提问 1", "编辑 `a.go`", "(+2 −1)", "### 回答", "最终回答", "C:/work/shop"} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown lacks %q:\n%s", want, md)
		}
	}
	if !strings.Contains(md, "````\n写") {
		t.Fatalf("the prompt's fence was not lengthened:\n%s", md)
	}
}

// TestExportDialogMarkdown writes a .md from the session header.
func TestExportDialogMarkdown(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	dir := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	app := startApp(t, dir, 1280, 860)
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-overview", 5*time.Second)
	app.Press("id:drawer-tab-overview")
	app.WaitFor("id:export-button", 5*time.Second)
	app.Press("id:export-button")
	app.WaitFor("id:export-dialog", 5*time.Second)
	app.Press("id:export-markdown")
	deadline := time.Now().Add(5 * time.Second)
	for {
		files, _ := filepath.Glob(filepath.Join(home, "exports", "*.md"))
		if len(files) > 0 {
			raw, err := os.ReadFile(files[0])
			if err != nil || !strings.Contains(string(raw), "# 新会话") {
				t.Fatalf("markdown = %q, %v", raw, err)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no Markdown export was written")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
