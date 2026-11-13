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
	if len(plugins) != 1 || plugins[0].Name != "团队提示词" || len(plugins[0].Commands) != 1 {
		t.Fatalf("plugins = %+v", plugins)
	}
	if plugins[0].Commands[0].Action.Type != "prompt" || plugins[0].Commands[0].Action.Prompt == "" {
		t.Fatalf("legacy prompt did not become a command: %+v", plugins[0].Commands[0])
	}
	themes := app.loadThemes(plugins)
	ids := map[string]themeSpec{}
	for _, th := range themes {
		ids[th.ID] = th
	}
	if _, ok := ids["user:mist"]; !ok {
		t.Fatalf("theme ids = %v, want user:mist", ids)
	}
	if ids["user:mist"].Name != "雾蓝" {
		t.Fatalf("theme name = %q", ids["user:mist"].Name)
	}
	foundPluginTheme := false
	for _, th := range themes {
		if th.Name == "插件蓝" {
			foundPluginTheme = true
		}
	}
	if !foundPluginTheme {
		t.Fatalf("plugin theme is missing: %+v", themes)
	}
}

// TestPluginManifestV2 checks contributes.commands, theme paths and the
// checks that keep a bad command out.
func TestPluginManifestV2(t *testing.T) {
	dir := t.TempDir()
	plugDir := filepath.Join(dir, "plugins", "team")
	if err := os.MkdirAll(filepath.Join(plugDir, "themes"), 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{
  "id": "team",
  "name": "团队",
  "version": "1.2.0",
  "description": "团队命令",
  "contributes": {
    "commands": [
      {"id": "review", "title": "梳理改动", "group": "团队", "icon": "git",
       "action": {"type": "prompt", "prompt": "看看改动。"}},
      {"id": "open", "title": "打开文档", "icon": "globe",
       "action": {"type": "url", "url": "https://example.com/docs"}},
      {"id": "bad", "title": "坏命令", "action": {"type": "exec", "prompt": "rm -rf"}},
      {"id": "empty", "title": "空命令", "action": {"type": "prompt"}}
    ],
    "themes": ["themes/blue.json", "../escape.json"],
    "keybindings": [{"command": "review", "key": "mod+shift+r"}]
  }
}`
	if err := os.WriteFile(filepath.Join(plugDir, "plugin.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	theme := `{"name":"团队蓝","appearance":"dark","radius":10,"light":{"accent":"#3366ff"}}`
	if err := os.WriteFile(filepath.Join(plugDir, "themes", "blue.json"), []byte(theme), 0o644); err != nil {
		t.Fatal(err)
	}
	app := &app{}
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	app.st = st
	plugins := app.loadPlugins()
	if len(plugins) != 1 {
		t.Fatalf("plugins = %+v", plugins)
	}
	p := plugins[0]
	if p.ID != "team" || p.Version != "1.2.0" {
		t.Fatalf("metadata = %+v", p)
	}
	if len(p.Commands) != 2 {
		t.Fatalf("commands = %+v, want 2", p.Commands)
	}
	if len(p.Warnings) < 2 {
		t.Fatalf("warnings = %v, want at least 2", p.Warnings)
	}
	if len(p.ThemeSpecs) != 1 || p.ThemeSpecs[0].Name != "团队蓝" || p.ThemeSpecs[0].Appearance != "dark" {
		t.Fatalf("themes = %+v", p.ThemeSpecs)
	}
	if p.ThemeSpecs[0].Radius != 10 {
		t.Fatalf("radius = %v", p.ThemeSpecs[0].Radius)
	}
	if len(p.Contributes.Keybindings) != 1 {
		t.Fatalf("keybindings = %+v", p.Contributes.Keybindings)
	}
	themes := app.loadThemes(plugins)
	found := false
	for _, th := range themes {
		if th.ID == "plugin:team:blue" {
			found = true
		}
	}
	if !found {
		t.Fatalf("plugin theme id missing: %+v", themes)
	}
}

// TestPluginDisabled checks that a disabled plugin adds no commands or
// themes.
func TestPluginDisabled(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "plugins"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"id":"team","name":"团队","contributes":{"commands":[{"id":"x","title":"X","action":{"type":"prompt","prompt":"x"}}]}}`
	if err := os.WriteFile(filepath.Join(dir, "plugins", "team.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) { c.DisabledPlugins = []string{"team"} })
	app := &app{st: st, cfg: st.config()}
	plugins := app.loadPlugins()
	if len(plugins) != 1 || !plugins[0].Disabled {
		t.Fatalf("plugins = %+v", plugins)
	}
}

// TestThemeTokens checks a theme's tokens, fonts and radius reach the
// palette.
func TestThemeTokens(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "themes"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"name":"紧凑","radius":12,"sans":"Inter","mono":"JetBrains Mono","tokens":{"font-sans":"Inter","radius":"12px"},"light":{"accent":"#123456"}}`
	if err := os.WriteFile(filepath.Join(dir, "themes", "compact.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	app := &app{st: st, cfg: st.config()}
	themes := app.loadThemes(nil)
	var got *themeSpec
	for i := range themes {
		if themes[i].ID == "user:compact" {
			got = &themes[i]
		}
	}
	if got == nil {
		t.Fatalf("compact theme missing: %+v", themes)
	}
	if got.Radius != 12 || got.Sans != "Inter" || got.Mono != "JetBrains Mono" {
		t.Fatalf("theme = %+v", got)
	}
	if got.Tokens["font-sans"] != "Inter" {
		t.Fatalf("tokens = %+v", got.Tokens)
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
	app.Press("id:settings-tab-keys")
	app.WaitFor("text:全部恢复默认", 5*time.Second)
	app.Press("id:settings-tab-look")
	app.WaitFor(`text:"配色"`, 5*time.Second)
	app.Press("id:settings-tab-addons")
	app.WaitFor("text:打开插件目录", 5*time.Second)
	app.Press("id:settings-tab-integrations")
	app.WaitFor("text:飞书机器人", 5*time.Second)
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

// TestRevealCommands checks the file-manager commands each target builds.
func TestRevealCommands(t *testing.T) {
	cmd, err := revealCmd(localTarget, `C:\proj`)
	if err != nil {
		t.Fatal(err)
	}
	if len(cmd.Args) == 0 || !strings.Contains(strings.ToLower(cmd.Args[0]), "explorer") {
		t.Fatalf("local reveal runs %v", cmd.Args)
	}
	file, err := revealFileCmd(localTarget, `C:\proj\a.jsonl`)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(file.Args, " ")
	if !strings.Contains(joined, "/select,") || !strings.Contains(joined, "a.jsonl") {
		t.Fatalf("file reveal runs %q", joined)
	}
	wsl, err := revealCmd(target{Kind: targetWSL, Distro: "Ubuntu"}, "/mnt/c/Users/me/p")
	if err != nil {
		t.Fatal(err)
	}
	wslJoined := strings.Join(wsl.Args, " ")
	if !strings.Contains(wslJoined, "Ubuntu") || !strings.Contains(wslJoined, `C:\Users\me\p`) {
		t.Fatalf("wsl reveal runs %q", wslJoined)
	}
	if _, err := revealCmd(target{Kind: targetSSH, Host: "box"}, "/srv"); err == nil {
		t.Fatal("ssh reveal should refuse")
	}
}
