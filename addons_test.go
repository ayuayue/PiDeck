package main

// Checks for the pieces that make the app configurable: where agents run,
// the looks, the add-ons, and pi's own sessions in the rail.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/nsgotest"
)

// TestTargetCommands checks how each target assembles pi's process.
func TestTargetCommands(t *testing.T) {
	cases := []struct {
		name   string
		target target
		want   []string
	}{
		{"local", localTarget, []string{"pi", "--mode", "rpc", "--session-dir", "/tmp/s", "--session-id", "abc"}},
		{"local file", localTarget, []string{"pi", "--mode", "rpc", "--session", "/x/y.jsonl"}},
	}
	for _, c := range cases {
		file := ""
		id := "abc"
		if len(c.want) > 3 && c.want[3] == "--session" {
			file, id = "/x/y.jsonl", ""
		}
		cmd, err := c.target.command("pi", "/work", "/tmp/s", id, file, []string{"--mode", "rpc"})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := strings.Join(cmd.Args, " "); got != strings.Join(c.want, " ") {
			t.Errorf("%s: %q, want %q", c.name, got, strings.Join(c.want, " "))
		}
	}

	if _, err := (target{Kind: targetWSL, Distro: "Ubuntu"}).command("pi", "/w", "", "abc", "", []string{"--mode", "rpc"}); err != nil {
		t.Fatalf("wsl: %v", err)
	}
	cmd, err := (target{Kind: targetSSH, Host: "me@box"}).command("pi", "/srv/a b", "", "abc", "", []string{"--mode", "rpc"})
	if err != nil {
		t.Fatalf("ssh: %v", err)
	}
	joined := strings.Join(cmd.Args, " ")
	for _, want := range []string{"ssh", "me@box", "/srv/a b", "--session-id", "abc", remoteDir} {
		if !strings.Contains(joined, want) {
			t.Errorf("ssh argv %q lacks %q", joined, want)
		}
	}
}

// TestParseTarget checks the round trip through a workspace's config key.
func TestParseTarget(t *testing.T) {
	for _, key := range []string{"", "wsl:Ubuntu", "ssh:me@box"} {
		got := parseTarget(key)
		if got.key() != key {
			t.Errorf("%q came back as %q", key, got.key())
		}
	}
}

// TestThemeOverrides checks that a user theme's roles replace the palette's.
func TestThemeOverrides(t *testing.T) {
	base := pideckTheme()
	before := base.Light.Background
	applyRoles(&base.Light, map[string]string{"background": "#123456", "accent": "not a color"})
	if base.Light.Background == before {
		t.Fatal("background did not change")
	}
	if r, _, _, _ := base.Light.Background.Components(); r > 0.08 {
		t.Fatalf("background is not dark blue: %v", r)
	}
}

// TestPluginAndThemeFiles checks the documented JSON formats load.
func TestPluginAndThemeFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "plugins"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "themes"), 0o755); err != nil {
		t.Fatal(err)
	}
	plugin := `{"name":"团队提示词","description":"常用检查","prompts":[{"title":"跑测试","prompt":"跑一遍测试"}],"themes":[{"name":"插件蓝","light":{"accent":"#3366ff"}}]}`
	if err := os.WriteFile(filepath.Join(dir, "plugins", "team.json"), []byte(plugin), 0o644); err != nil {
		t.Fatal(err)
	}
	theme := `{"name":"雾蓝","light":{"background":"#f7f9fc"}}`
	if err := os.WriteFile(filepath.Join(dir, "themes", "mist.json"), []byte(theme), 0o644); err != nil {
		t.Fatal(err)
	}
	app := &app{}
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	app.st = st
	plugins := app.loadPlugins()
	if len(plugins) != 1 || plugins[0].Name != "团队提示词" || len(plugins[0].Prompts) != 1 {
		t.Fatalf("plugins = %+v", plugins)
	}
	themes := app.loadThemes(plugins)
	var ids []string
	for _, th := range themes {
		ids = append(ids, th.ID)
	}
	joined := strings.Join(ids, ",")
	for _, want := range []string{"system", "light", "dark", "user:雾蓝", "user:插件蓝"} {
		if !strings.Contains(joined, want) {
			t.Errorf("themes %q lack %q", joined, want)
		}
	}
}

// TestPiSessionsInRail checks that pi's own sessions show up and open.
func TestPiSessionsInRail(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	workspace := t.TempDir()
	piSessions := t.TempDir()
	src := filepath.Join(piSessions, "--x--", "2026-01-02T03-04-05Z_abc.jsonl")
	if err := os.MkdirAll(filepath.Dir(src), 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"type":"session","version":3,"id":"aaaaaaaa-2222-4333-8444-555555555555","timestamp":"2026-01-02T03:04:05.000Z","cwd":"` + filepath.ToSlash(workspace) + `"}
{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":"终端里的旧提问","timestamp":1767323046000}}
`
	if err := os.WriteFile(src, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", piSessions)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.PickDirectories = func(core.DirectoriesRequest) []core.Directory {
		return []core.Directory{{Name: filepath.Base(workspace), Path: workspace}}
	}
	app.Press("id:welcome-primary")
	// pi's session belongs to the folder, so it is listed under its project.
	waitApp(app, "text:终端里的旧提问", 30*time.Second)
	shot(app, "40-pi-sessions")
}

// TestSettingsTabs checks the settings dialog's sections render.
func TestSettingsTabs(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-env", 5*time.Second)
	app.Press("id:settings-tab-models")
	app.WaitFor("text:供应商与认证", 5*time.Second)
	app.Press("id:settings-tab-look")
	app.WaitFor(`text:"配色"`, 5*time.Second)
	app.Press("id:settings-tab-addons")
	app.WaitFor("text:打开插件目录", 5*time.Second)
	app.Press("id:settings-tab-data")
	app.WaitFor(`text:"数据目录"`, 5*time.Second)
	shot(app, "41-settings")
}

// TestSessionGroups checks a project's sessions are grouped by when they
// changed, with pi's own among them.
func TestSessionGroups(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	workspace := t.TempDir()
	piSessions := t.TempDir()
	write := func(id, when, text string) {
		dir := filepath.Join(piSessions, "--x--")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		body := fmt.Sprintf(`{"type":"session","version":3,"id":"%s","timestamp":"%s","cwd":"%s"}
{"type":"message","id":"a1","parentId":null,"timestamp":"%s","message":{"role":"user","content":"%s","timestamp":1767323046000}}
`, id, when, filepath.ToSlash(workspace), when, text)
		name := strings.NewReplacer(":", "-", ".", "-").Replace(when) + "_" + id + ".jsonl"
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC()
	write("aaaaaaaa-0000-4000-8000-000000000001", now.Format("2026-01-02T15:04:05.000Z"), "今天的会话")
	write("bbbbbbbb-0000-4000-8000-000000000002", now.Add(-50*time.Hour).Format("2026-01-02T15:04:05.000Z"), "更早的会话")
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", piSessions)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.PickDirectories = func(core.DirectoriesRequest) []core.Directory {
		return []core.Directory{{Name: filepath.Base(workspace), Path: workspace}}
	}
	app.Press("id:welcome-primary")
	waitApp(app, "text:今天的会话", 30*time.Second)
	app.Find("text:今天")
	if len(app.Query("text:更早的会话")) == 0 {
		t.Fatal("the older session is not listed")
	}
}
