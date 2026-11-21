//go:build !js && !android && !ios

package workbench

// Checks the tool models: the chat client, the per-tool settings and the
// prompt tools that use them.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func fakeProviders(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	raw := `{"providers":{"fake":{"api":"openai-completions","baseUrl":"http://127.0.0.1:9",
		"apiKey":"k","models":[{"id":"fast","name":"Fast"},{"id":"smart","name":"Smart"}]}}}`
	if err := os.WriteFile(filepath.Join(dir, "models.json"), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLLMOpenAI(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		io.WriteString(w, `{"choices":[{"message":{"content":"hello"}}]}`)
	}))
	defer srv.Close()
	got, err := llmOpenAI(context.Background(), providerConfig{BaseURL: srv.URL}, modelConfig{ID: "m"}, "k", "sys", "hi", 10)
	if err != nil || got != "hello" {
		t.Fatalf("llmOpenAI = %q, %v", got, err)
	}
}

func TestLLMAnthropic(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("anthropic-version") == "" {
			t.Error("no anthropic-version")
		}
		io.WriteString(w, `{"content":[{"type":"text","text":"bonjour"}]}`)
	}))
	defer srv.Close()
	got, err := llmAnthropic(context.Background(), providerConfig{BaseURL: srv.URL}, modelConfig{ID: "m"}, "k", "sys", "hi", 10)
	if err != nil || got != "bonjour" {
		t.Fatalf("llmAnthropic = %q, %v", got, err)
	}
}

func TestToolModelsPerTool(t *testing.T) {
	fakeProviders(t)
	home, workspace := editorWorkspace(t), editorWorkspace(t)
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, _ := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "ToolProject"}},
		Theme: "system", SidebarOpen: true})
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	built.openSettingsPane()
	built.settingsTab.Set("models")
	screen.Advance(300 * time.Millisecond)
	screen.WaitFor("id:tool-commit-provider", 5*time.Second)
	screen.WaitFor("id:provider-configure-fake", 10*time.Second)

	screen.Press("id:tool-commit-provider")
	screen.WaitFor("id:tool-commit-provider-0", 5*time.Second)
	screen.Press("id:tool-commit-provider-0")
	screen.Advance(100 * time.Millisecond)
	if got := built.cfg.ToolModels["commit"]; got.Provider != "fake" || got.Model != "fast" {
		t.Fatalf("commit tool = %+v", got)
	}

	// Each tool keeps its own model, not a shared one.
	built.setToolModel("prompt", "fake", "smart")
	screen.Advance(100 * time.Millisecond)
	if got := built.cfg.ToolModels["prompt"]; got.Provider != "fake" || got.Model != "smart" {
		t.Fatalf("prompt tool = %+v", got)
	}
	if built.cfg.ToolModels["commit"].Model != "fast" {
		t.Fatalf("commit tool changed with prompt: %+v", built.cfg.ToolModels)
	}
}

func TestPromptToolsUseTheirModel(t *testing.T) {
	fakeProviders(t)
	home, workspace := editorWorkspace(t), editorWorkspace(t)
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, _ := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "ToolProject"}},
		Theme: "system", SidebarOpen: true,
		ToolModels: map[string]toolModelCfg{
			"prompt":  {Provider: "fake", Model: "smart"},
			"predict": {Provider: "fake", Model: "fast"},
		}})
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	screen.Advance(100 * time.Millisecond)
	ws := built.workspaces.GetUntracked()[0]
	s := built.makeSession(sessionMeta{ID: "tool-s", Cwd: ws.Path, Title: "工具", Updated: time.Now()}, ws.Target)
	built.llmFn = func(tool, system, prompt string, max int) (string, error) {
		switch tool {
		case "prompt":
			return "更清楚的提示词", nil
		case "predict":
			return "下一句", nil
		}
		return "", nil
	}

	s.draft.Set("写清楚一点")
	built.enhanceDraft(s)
	screen.WaitUntil(5*time.Second, func() bool { return s.draft.GetUntracked() == "更清楚的提示词" })

	built.predictDraft(s)
	screen.WaitUntil(5*time.Second, func() bool { return s.draft.GetUntracked() == "更清楚的提示词 下一句" })
}

func TestCommitSummaryUsesCommitTool(t *testing.T) {
	fakeProviders(t)
	workspace := editorWorkspace(t)
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = workspace
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "a@b.c")
	run("config", "user.name", "A")
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "feat: start")
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello again\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")

	home := editorWorkspace(t)
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, _ := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "CommitProject", Expanded: true}},
		Theme: "system", SidebarOpen: true})
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	screen.Advance(100 * time.Millisecond)
	ws := built.workspaces.GetUntracked()[0]
	built.git.attach(ws)
	built.git.refreshAll()
	screen.WaitUntil(10*time.Second, func() bool { return built.gitPath() != "" })
	built.setToolModel("commit", "fake", "fast")

	var promptSeen string
	built.llmFn = func(tool, system, prompt string, max int) (string, error) {
		if tool != "commit" {
			t.Errorf("tool = %q", tool)
		}
		promptSeen = prompt
		return "feat: update the note", nil
	}
	built.generateCommitMessage()
	screen.WaitUntil(20*time.Second, func() bool { return built.git.msg.GetUntracked() == "feat: update the note" })
	if !strings.Contains(promptSeen, "hello again") {
		t.Fatalf("prompt did not carry the diff: %s", promptSeen)
	}
}
