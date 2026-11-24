//go:build !js && !android && !ios

package workbench

// Checks the local HTML export.

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

func TestShareExportMasksSecretsAndDropsPrivateData(t *testing.T) {
	project := `C:\Users\alice\src\private-project`
	credential := "sk-proj-abcdefghijklmnopqrstuv"
	d := exportData{
		Title: "Private title", Project: project, Model: "private-model", When: time.Now(),
		Turns: []turn{{
			Prompt: "Please inspect " + project + " with API_KEY=" + credential +
				" and ![diagram](https://private.example/image.png)",
			Steps: []turnStep{{Thinking: "private reasoning", Text: "intermediate prose", Tools: []toolRun{{
				Action: "运行", Detail: "private command", Output: "private tool output",
			}}}},
			Final: "Use token " + credential + " at " + project,
			Err:   "private error details",
		}},
	}
	shared := shareExport(d, []string{"another-private-token"})
	if shared.Title != "分享副本" || !shared.Shared || shared.Project != "" || shared.Model != "" || !shared.When.IsZero() || shared.Usage.Total != 0 {
		t.Fatalf("share metadata = %+v", shared)
	}
	if len(shared.Turns) != 1 {
		t.Fatalf("share turns = %+v", shared.Turns)
	}
	output := renderSessionMarkdown(shared) + renderSessionHTML(shared)
	for _, private := range []string{project, credential, "private-project", "private reasoning", "intermediate prose", "private command", "private tool output", "private error details", "private.example/image.png", "another-private-token", "Private title", "private-model"} {
		if strings.Contains(output, private) {
			t.Errorf("share output contains %q", private)
		}
	}
	if !strings.Contains(output, "Please inspect") || !strings.Contains(output, "Use token") || !strings.Contains(output, shareRedacted) {
		t.Fatalf("share output lost conversation text or redaction markers:\n%s", output)
	}
}

func TestShareExportRedactsStandaloneTokens(t *testing.T) {
	// Synthetic credentials keep this test independent of user configuration.
	payload := strings.Repeat("a", 24)
	tests := []struct {
		name, text, want string
	}{
		{"stripe_secret_live", "sk_live_" + payload, shareRedacted},
		{"stripe_secret_test", "sk_test_" + payload, shareRedacted},
		{"stripe_restricted_live", "rk_live_" + payload, shareRedacted},
		{"stripe_restricted_test", "rk_test_" + payload, shareRedacted},
		{"gitlab_personal", "glpat-" + payload, shareRedacted},
		{"gitlab_deploy", "gldt-" + payload, shareRedacted},
		{"gitlab_runner", "glrt-" + payload, shareRedacted},
		{"gitlab_job", "glcbt-" + payload, shareRedacted},
		{"google_oauth_client", "gocspx-" + payload, shareRedacted},
		{"bearer", "Bearer " + payload, "Bearer " + shareRedacted},
		{"bearer_case_tab", "bEaReR\t" + payload, "bEaReR\t" + shareRedacted},
		{"bearer_base64", "Bearer " + payload + "+/~._-==", "Bearer " + shareRedacted},
		{"quoted", "'sk_live_" + payload + "', preserved.", "'" + shareRedacted + "', preserved."},
		{"multiple", "glpat-" + payload + ", sk_test_" + payload, shareRedacted + ", " + shareRedacted},
		{"html_entity_prefix", "<span>&#115;k_live_" + payload + "</span>", shareRedacted},
		{"html_entity_bearer", "<span>&#66;earer " + payload + "</span>", "Bearer " + shareRedacted},
		{"plain_entity_prefix", "&#115;k_live_" + payload, shareRedacted},
		{"plain_entity_bearer", "&#66;earer " + payload, "Bearer " + shareRedacted},
		{"public_key", "pk_live_" + payload, "pk_live_" + payload},
		{"short_identifier", "sk_live_field", "sk_live_field"},
		{"ordinary_bearer_text", "bearer authentication", "bearer authentication"},
		{"embedded_prefix", "featureglpat-" + payload, "featureglpat-" + payload},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			text := "Before " + tt.text + " after"
			want := "Before " + tt.want + " after"
			d := exportData{Turns: []turn{{Prompt: text, Final: text}}}
			shared := shareExport(d, nil)
			if len(shared.Turns) != 1 || shared.Turns[0].Prompt != want || shared.Turns[0].Final != want {
				t.Fatalf("share turns = %+v, want prompt and answer %q", shared.Turns, want)
			}
			if d.Turns[0].Prompt != text || d.Turns[0].Final != text {
				t.Fatal("redaction modified the source transcript")
			}
			if tt.text != tt.want {
				for _, out := range []string{renderSessionHTML(shared), renderSessionMarkdown(shared)} {
					if strings.Contains(out, tt.text) {
						t.Fatalf("rendered share copy contains the synthetic credential for %s", tt.name)
					}
				}
			}
		})
	}
}

func TestExportClosedSessionDefaultsToShareCopy(t *testing.T) {
	home, project := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	const id = "closed-share"
	const title = "私有会话名称"
	const secret = "fixture-value-for-share-export"
	dir := filepath.Join(home, "sessions", encodeCwd(project))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, id+".jsonl")
	body := piSessionFile(id, project) + fmt.Sprintf(`{"type":"message","id":"reply","message":{"role":"assistant","content":[{"type":"thinking","thinking":"不可分享的思考"},{"type":"text","text":%q}]}}`+"\n", "保留这段回答，API_KEY="+secret)
	cfg, err := json.Marshal(config{Version: configVersion, Theme: "system", SidebarOpen: true,
		Workspaces: []workspaceCfg{{Path: project, Expanded: true}}, Titles: map[string]string{id: title}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1280, 860))
	// Add the file after startup so restoring the newest session cannot load
	// this transcript or launch pi before the export reads its file.
	if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	s := built.makeSession(sessionMeta{ID: id, Cwd: project, File: file, Title: title}, localTarget)
	open := func() {
		built.openExport(s)
		screen.WaitFor("id:export-dialog", 5*time.Second)
	}
	open()
	screen.Press("id:export-markdown")
	screen.WaitFor("text:已导出分享副本", 5*time.Second)
	files, err := filepath.Glob(filepath.Join(home, "exports", "*.md"))
	if err != nil || len(files) != 1 {
		t.Fatalf("share files = %v, %v", files, err)
	}
	data, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, id) || !strings.Contains(text, "保留这段回答") {
		t.Fatalf("closed session's conversation is missing:\n%s", text)
	}
	for _, private := range []string{title, project, secret, "不可分享的思考"} {
		if strings.Contains(text, private) || strings.Contains(filepath.Base(files[0]), private) {
			t.Errorf("share copy exposes %q", private)
		}
	}

	open()
	screen.Press("id:export-mode-original")
	screen.Press("id:export-copy")
	screen.WaitUntil(5*time.Second, func() bool { return strings.Contains(screen.Clipboard, secret) })
	if !strings.Contains(screen.Clipboard, title) {
		t.Fatalf("original title is missing: %q", screen.Clipboard)
	}
	open()
	screen.Press("id:export-copy")
	screen.WaitUntil(5*time.Second, func() bool { return !strings.Contains(screen.Clipboard, secret) })
	if !strings.Contains(screen.Clipboard, "保留这段回答") || strings.Contains(screen.Clipboard, title) {
		t.Fatalf("copy did not return to share mode: %q", screen.Clipboard)
	}
	if s.loaded.GetUntracked() || s.engine != nil {
		t.Fatal("export loaded or started the closed session")
	}
	if raw, err := os.ReadFile(file); err != nil || string(raw) != body {
		t.Fatalf("source session changed (read error: %v)", err)
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
	t.Setenv("PIDECK_V2_HOME", home)
	app := startApp(t, dir, 1280, 860)
	// Export is a session command now: the drawer's overview reports, it
	// does not repeat the menus' actions.
	app.Press("id:rail-palette")
	app.Type("label:命令", "导出会话")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option")) > 0 })
	app.Press("role:option >> nth=0")
	app.WaitFor("id:export-dialog", 5*time.Second)
	app.Press("id:export-mode-original")
	app.Press("id:export-markdown")
	app.WaitFor("text:已导出 Markdown", 5*time.Second)
	files, err := filepath.Glob(filepath.Join(home, "exports", "*.md"))
	if err != nil || len(files) != 1 {
		t.Fatalf("export files = %v, %v", files, err)
	}
	raw, err := os.ReadFile(files[0])
	if err != nil || !strings.Contains(string(raw), "# 新会话") {
		t.Fatalf("markdown = %q, %v", raw, err)
	}
}

// TestExportDialogWindowPNG saves the window as a PNG. Capture is the one
// export that needs real pixels, so it runs on a platform target only.
func TestExportDialogWindowPNG(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("capture needs real pixels; run under nsgo test -target")
	}
	built, screen, sess := startNativeSurfaceApp(t)
	onNativeUI(t, screen, built, func() { built.openExport(sess) })
	screen.WaitFor("id:export-dialog", 10*time.Second)
	screen.Press("id:export-image")
	screen.WaitFor("text:已导出图片", 20*time.Second)
	dir := ""
	onNativeUI(t, screen, built, func() { dir = built.st.dir })
	files, err := filepath.Glob(filepath.Join(dir, "exports", "*.png"))
	if err != nil || len(files) != 1 {
		t.Fatalf("export files = %v, %v", files, err)
	}
	raw, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 1024 || !strings.HasPrefix(string(raw), "\x89PNG") {
		t.Fatalf("png is %d bytes and starts with %q", len(raw), string(raw[:min(8, len(raw))]))
	}
}
