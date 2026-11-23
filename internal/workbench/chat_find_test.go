//go:build !js && !android && !ios

package workbench

// Checks finding a turn in the open conversation.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestTurnMatches(t *testing.T) {
	turn := turn{ID: "t", Prompt: "部署到生产", Final: "先跑流水线",
		Steps: []turnStep{{Text: "检查配置", Thinking: "先看环境变量",
			Tools: []toolRun{{Name: "bash", Detail: "npm test", Output: "3 passed"}}}}}
	for _, q := range []string{"部署", "流水线", "配置", "环境变量", "npm", "passed"} {
		if !turnMatches(turn, q) {
			t.Errorf("turnMatches(%q) = false, want true", q)
		}
	}
	if turnMatches(turn, "不存在的词") {
		t.Error("turnMatches matched a word that is not there")
	}
}

// TestChatFind filters the transcript to the turns that match.
func TestChatFind(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	turns := []turn{
		{ID: "t0", Prompt: "部署到生产环境", Final: "先跑流水线。", Status: chat.Completed, Start: base, End: base.Add(time.Minute)},
		{ID: "t1", Prompt: "给这个项目写测试", Final: "测试写在 x_test.go。", Status: chat.Completed, Start: base.Add(time.Minute), End: base.Add(2 * time.Minute)},
		{ID: "t2", Prompt: "修一个 bug", Final: "改好了。", Status: chat.Completed, Start: base.Add(2 * time.Minute), End: base.Add(3 * time.Minute)},
	}
	arch := acpArchive{ID: "acp-find", Preset: "fake", Title: "查找会话", Cwd: workspace, Updated: base, Turns: turns}
	raw, err := json.Marshal(arch)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "acp-sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "acp-find.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := json.Marshal(config{Version: 2,
		Workspaces:  []workspaceCfg{{Path: workspace, Name: "查找项目", Expanded: true}},
		Theme:       "system",
		SidebarOpen: true,
		ScanPi:      false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("role:button 查找会话")) > 0 })
	app.Press("role:button 查找会话 >> nth=0")
	app.WaitFor("text:部署到生产环境", 10*time.Second)

	app.Key("mod+f")
	app.WaitFor("id:chat-find-input", 5*time.Second)
	app.Type("id:chat-find-input", "测试")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:部署到生产环境")) == 0 })
	app.WaitFor("text:给这个项目写测试", 5*time.Second)
	app.WaitFor("text:1 条匹配", 5*time.Second)
	app.WaitFor("text:1 处", 5*time.Second)

	app.Press("id:chat-find-close")
	app.WaitFor("text:部署到生产环境", 5*time.Second)
}
