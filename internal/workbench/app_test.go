//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/nsgo-dev/nsgo"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestMain gives the platform the main thread under nsgo test -target.
func TestMain(m *testing.M) {
	// Tests drive the Chinese source strings; a language switch test sets
	// the config itself, which wins over this.
	os.Setenv("PIDECK_LITE_LANG", "zh-CN")
	// UI tests must not scan the developer's real session library in the
	// background. Tests of external sessions supply their own fixtures.
	os.Setenv("PI_CODING_AGENT_SESSION_DIR", filepath.Join(os.TempDir(), fmt.Sprintf("pideck-lite-test-%d", os.Getpid()), "pi-sessions"))
	// Starting the app installs the bundled skills under pi's config dir;
	// keep that out of the developer's real ~/.pi/agent.
	if piConfig, err := os.MkdirTemp("", fmt.Sprintf("pideck-lite-pi-config-%d", os.Getpid())); err == nil {
		os.Setenv("PIDECK_LITE_PI_CONFIG", piConfig)
	}
	nsgotest.Main(m)
}

// TestWelcome checks the first screen: the wordmark, the rail and the
// invitation to add a workspace.
func TestWelcome(t *testing.T) {
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Find(`text:"PiDeck Lite"`)
	app.Find("text:添加工作区")
	app.Find("text:导入会话")
}

// TestWorkspacePicker adds the current folder through the browser and
// checks both the system picker and the app's own browser add it.
func TestWorkspacePicker(t *testing.T) {
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	// The system's picker answers with the current folder (headless only:
	// a real window opens the platform's own dialog).
	app.PickDirectories = func(core.DirectoriesRequest) []core.Directory {
		dir, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		return []core.Directory{{Name: filepath.Base(dir), Path: dir}}
	}
	if nsgotest.Target() == "" {
		app.Press("id:welcome-primary")
		app.WaitFor("text:打开一个会话，或者新建一个。", 5*time.Second)
	}
	// The app's own browser: the palette opens it and the current folder is
	// chosen through it.
	app.Press("id:rail-palette")
	app.Press("text:浏览文件夹添加工作区")
	app.WaitFor("text:选择这个文件夹", 5*time.Second)
	app.Press("text:当前目录")
	app.Press("text:选择这个文件夹")
	app.Settle()
	shot(app, "workspace")
}

// TestScreens captures the first screens on a platform.
func TestScreens(t *testing.T) {
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	shot(app, "01-welcome")
	app.Press("id:rail-palette")
	app.Press("text:浏览文件夹添加工作区")
	app.WaitFor("text:选择这个文件夹", 5*time.Second)
	shot(app, "02-picker")
	app.Press("text:当前目录")
	app.Advance(200 * time.Millisecond)
	shot(app, "03-picker-folder")
}

// TestSessionScreens opens a real session through pi and captures the
// chat, composer and drawer.
func TestSessionScreens(t *testing.T) {
	requirePi(t)
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	t.Cleanup(closeAllPi)
	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	app.PickDirectories = func(core.DirectoriesRequest) []core.Directory {
		return []core.Directory{{Name: filepath.Base(dir), Path: dir}}
	}
	app.Press("id:welcome-primary")
	app.WaitFor("text:打开一个会话，或者新建一个。", 10*time.Second)
	app.Press("id:welcome-primary")
	waitApp(app, "id:pi-ready", 60*time.Second)
	app.Advance(300 * time.Millisecond)
	shot(app, "06-session")
	app.Press("label:会话面板")
	app.WaitFor(`text:"概览"`, 5*time.Second)
	shot(app, "07-drawer")
	app.Press("id:drawer-tab-files")
	app.Advance(300 * time.Millisecond)
	shot(app, "08-files")
}

// TestRebuild checks that pi's message history becomes turns: one per user
// message, with tool calls and their results joined.
func TestRebuild(t *testing.T) {
	raw := `[
	 {"role":"user","content":"看看目录","timestamp":1},
	 {"role":"assistant","model":"gpt-5.5","content":[{"type":"thinking","thinking":"先列目录"},{"type":"text","text":"我先看看。"},{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"ls -la"}}],"usage":{"input":10,"output":5,"totalTokens":15,"cost":{"total":0.001}},"stopReason":"toolUse","timestamp":2},
	 {"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"a.txt\nb.txt"}],"isError":false,"timestamp":3},
	 {"role":"assistant","content":[{"type":"text","text":"目录里有两个文件。"}],"usage":{"input":20,"output":6,"totalTokens":26,"cost":{"total":0.002}},"stopReason":"stop","timestamp":4}
	]`
	var msgs []piMessage
	if err := json.Unmarshal([]byte(raw), &msgs); err != nil {
		t.Fatal(err)
	}
	turns := turnsFromMessages(msgs)
	if len(turns) != 1 {
		t.Fatalf("turns = %d, want 1", len(turns))
	}
	tt := turns[0]
	if tt.Prompt != "看看目录" {
		t.Fatalf("prompt = %q", tt.Prompt)
	}
	if tt.Final != "目录里有两个文件。" {
		t.Fatalf("final = %q", tt.Final)
	}
	if tt.Tools != 1 || len(tt.Steps) != 1 || len(tt.Steps[0].Tools) != 1 {
		t.Fatalf("tools = %d, steps = %d", tt.Tools, len(tt.Steps))
	}
	if tt.Steps[0].Tools[0].Output != "a.txt\nb.txt" {
		t.Fatalf("output = %q", tt.Steps[0].Tools[0].Output)
	}
	if tt.Steps[0].Thinking != "先列目录" {
		t.Fatalf("thinking = %q", tt.Steps[0].Thinking)
	}
	if tt.Usage.Total != 41 {
		t.Fatalf("usage = %d", tt.Usage.Total)
	}
	// The turn carries when it ran and what answered it, so the transcript
	// can stamp both.
	if !tt.Start.Equal(time.UnixMilli(1)) || !tt.End.Equal(time.UnixMilli(4)) {
		t.Fatalf("turn ran %v → %v, want the messages' own stamps", tt.Start, tt.End)
	}
	if tt.Model != "gpt-5.5" {
		t.Fatalf("model = %q", tt.Model)
	}
}

// TestToolSummary checks the labels tools show in the timeline.
func TestToolSummary(t *testing.T) {
	cases := []struct{ name, args, action, detail string }{
		{"bash", `{"command":"npm test"}`, "运行", "npm test"},
		{"read", `{"path":"src/app.ts"}`, "读取", "src/app.ts"},
		{"edit", `{"path":"a.go","old":"x"}`, "编辑", "a.go"},
		{"grep", `{"pattern":"TODO","path":"src"}`, "搜索", "TODO src"},
		{"web_search", `{"query":"nsgo"}`, "联网搜索", "nsgo"},
	}
	for _, c := range cases {
		action, detail := toolSummary(c.name, json.RawMessage(c.args))
		if action != c.action || detail != c.detail {
			t.Errorf("%s: (%q, %q), want (%q, %q)", c.name, action, detail, c.action, c.detail)
		}
	}
}

// TestEncodeCwd checks pi's session folder naming.
func TestEncodeCwd(t *testing.T) {
	if got := encodeCwd(`C:\Users\me\proj`); got != "--C--Users-me-proj--" {
		t.Fatalf("encodeCwd = %q", got)
	}
}

// TestStoreRoundTrip saves and reads the config and a session listing.
func TestStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.edit(func(c *config) {
		c.Workspaces = []workspaceCfg{{Path: `C:\proj`, Expanded: true}}
		c.Titles = map[string]string{"abc": "rename me"}
	})
	again, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := again.config()
	if len(cfg.Workspaces) != 1 || cfg.Workspaces[0].Path != `C:\proj` {
		t.Fatalf("workspaces = %+v", cfg.Workspaces)
	}
	if cfg.Titles["abc"] != "rename me" {
		t.Fatalf("titles = %+v", cfg.Titles)
	}
}
