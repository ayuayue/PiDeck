//go:build !js && !android && !ios

package workbench

// Checks for the pieces that make the app configurable: where agents run,
// the looks, the add-ons, and pi's own sessions in the rail.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
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

	// WSL is a Windows host's arrangement: elsewhere the target refuses to
	// build a command rather than pretend it could run one.
	if _, err := (target{Kind: targetWSL, Distro: "Ubuntu"}).command("pi", "/w", "", "abc", "", []string{"--mode", "rpc"}); err != nil {
		if runtime.GOOS == "windows" {
			t.Fatalf("wsl: %v", err)
		}
	} else if runtime.GOOS != "windows" {
		t.Fatal("a WSL target built a command off Windows")
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
	base := viewkit.Theme()
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
	plugins := app.loadPlugins(app.cfg.DisabledPlugins)
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
	plugins := app.loadPlugins(app.cfg.DisabledPlugins)
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
	plugins := app.loadPlugins(app.cfg.DisabledPlugins)
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
	requirePi(t)
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
	t.Setenv("PIDECK_V2_HOME", home)
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
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-env", 5*time.Second)
	app.Press("id:settings-tab-general")
	app.WaitFor("text:一轮完成时通知", 5*time.Second)
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
	app.Press("id:settings-tab-diagnostics")
	app.WaitFor("text:复制诊断信息", 5*time.Second)
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
	requirePi(t)
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
	t.Setenv("PIDECK_V2_HOME", home)
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
// Opening a folder is the platform's own program, and the WSL and SSH
// targets only exist where a Windows host has them.
func TestRevealCommands(t *testing.T) {
	cmd, err := revealCmd(localTarget, "C:/proj")
	if err != nil {
		t.Fatal(err)
	}
	if len(cmd.Args) == 0 {
		t.Fatal("local reveal built no command")
	}
	switch program := strings.ToLower(filepath.Base(cmd.Args[0])); runtime.GOOS {
	case "windows":
		if program != "explorer.exe" {
			t.Fatalf("local reveal runs %v", cmd.Args)
		}
	case "darwin":
		if program != "open" {
			t.Fatalf("local reveal runs %v", cmd.Args)
		}
	default:
		if program != "xdg-open" {
			t.Fatalf("local reveal runs %v", cmd.Args)
		}
	}

	file, err := revealFileCmd(localTarget, "C:/proj/a.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(file.Args, " ")
	switch runtime.GOOS {
	case "windows":
		if !strings.Contains(joined, "/select,") || !strings.Contains(joined, "a.jsonl") {
			t.Fatalf("file reveal runs %q", joined)
		}
	case "darwin":
		if !strings.Contains(joined, "-R") || !strings.Contains(joined, "a.jsonl") {
			t.Fatalf("file reveal runs %q", joined)
		}
	default:
		// No file manager protocol selects a file here: its folder opens.
		if !strings.Contains(joined, "C:/proj") {
			t.Fatalf("file reveal runs %q", joined)
		}
	}

	wsl, err := revealCmd(target{Kind: targetWSL, Distro: "Ubuntu"}, "/mnt/c/Users/me/p")
	if runtime.GOOS != "windows" {
		if err == nil {
			t.Fatalf("wsl reveal off Windows runs %v", wsl.Args)
		}
	} else {
		if err != nil {
			t.Fatal(err)
		}
		wslJoined := strings.Join(wsl.Args, " ")
		if !strings.Contains(wslJoined, "Ubuntu") || !strings.Contains(wslJoined, `C:\Users\me\p`) {
			t.Fatalf("wsl reveal runs %q", wslJoined)
		}
	}
	if _, err := revealCmd(target{Kind: targetSSH, Host: "box"}, "/srv"); err == nil {
		t.Fatal("ssh reveal should refuse")
	}
}

// TestPluginSettings checks a manifest's settings are validated, stored
// with defaults, and referenced from an action.
func TestPluginSettings(t *testing.T) {
	p := plugin{ID: "team", Contributes: pluginContrib{
		Settings: []pluginSetting{
			{Key: "lang", Label: "语言", Type: "select", Default: "zh", Options: []string{"zh", "en"}},
			{Key: "flag", Label: "开关", Type: "bool", Default: true},
			{Key: "lang", Label: "重复", Type: "string"},
			{Key: "bad key", Label: "坏", Type: "string"},
			{Key: "mode", Label: "模式", Type: "select"},
			{Key: "tone", Label: "语气", Type: "select", Default: "warm", Options: []string{"plain"}},
		},
		Commands: []pluginCommand{
			{ID: "go", Title: "走", Action: pluginAction{Type: "prompt", Prompt: "用 ${setting:lang} 回答，${setting:nope}"}},
		},
	}}
	normalizePlugin(&p)
	if len(p.Contributes.Settings) != 3 {
		t.Fatalf("settings = %+v", p.Contributes.Settings)
	}
	if got := settingText(p.Contributes.Settings[2].Default); got != "plain" {
		t.Errorf("select without a default = %q", got)
	}
	var badDefault bool
	for _, w := range p.Warnings {
		if strings.Contains(w, "warm") {
			badDefault = true
		}
	}
	if !badDefault {
		t.Fatalf("no warning for a default outside options: %v", p.Warnings)
	}
	if got := settingText(true); got != "true" {
		t.Errorf("bool = %q", got)
	}
	if got := settingText(3.5); got != "3.5" {
		t.Errorf("float = %q", got)
	}
	if got := pluginSettingValue(nil, p, "lang"); got != "zh" {
		t.Errorf("default = %q", got)
	}
	saved := map[string]string{"team/flag": "false", "team/lang": "en"}
	if got := pluginSettingValue(saved, p, "flag"); got != "false" {
		t.Errorf("saved = %q", got)
	}
	if got := pluginSettingValue(saved, p, "lang"); got != "en" {
		t.Errorf("saved select = %q", got)
	}
	var warned bool
	for _, w := range p.Warnings {
		if strings.Contains(w, "nope") {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("no warning for an undeclared setting: %v", p.Warnings)
	}
	a := &app{cfg: config{PluginSettings: saved}}
	if got := a.expandPluginText(p, "说 ${setting:lang}"); got != "说 en" {
		t.Errorf("expand = %q", got)
	}
	empty := &app{}
	if got := empty.expandPluginText(p, "说 ${setting:lang}"); got != "说 zh" {
		t.Errorf("default expand = %q", got)
	}
}

// TestPluginSettingUI flips a plugin's declared switch and runs a command
// that reads it.
func TestPluginSettingUI(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{
  "id": "team", "name": "测试插件", "version": "1.0.0",
  "contributes": {
    "settings": [{"key": "flag", "label": "开关测试", "type": "bool", "default": false}],
    "commands": [{"id": "check", "title": "开关检查", "action": {"type": "prompt", "prompt": "flag=${setting:flag}"}}]
  }
}`
	if err := os.WriteFile(filepath.Join(dir, "team.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_V2_HOME", home)
	app := openApp(t, workspace, 1280, 860)
	app.Press("label:设置")
	app.Press("id:settings-tab-addons")
	app.WaitFor("text:测试插件", 30*time.Second)
	app.WaitFor("id:plugin-setting-team-flag", 10*time.Second)
	app.Press("id:plugin-setting-team-flag")
	app.Press("id:settings-done")
	app.WaitForGone("id:settings-tab-addons", 5*time.Second)
	app.Press("id:rail-palette")
	app.Type("label:命令", "开关检查")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:开关检查")) > 0 })
	app.Press("role:option 开关检查")
	deadline := time.Now().Add(5 * time.Second)
	for {
		app.Settle()
		if strings.Contains(app.Find("id:composer").Text, "flag=true") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("composer = %q", app.Find("id:composer").Text)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestPluginAgents checks a plugin's agents are limited to valid ones.
func TestPluginAgents(t *testing.T) {
	p := plugin{ID: "team", Contributes: pluginContrib{Agents: []agentPersona{
		{ID: "review", Name: "团队审查", Description: "团队规则", Prompt: "按团队规则审查。"},
		{ID: "review", Name: "重复", Prompt: "重复的 id。"},
		{ID: "bad id", Name: "坏", Prompt: "x"},
		{ID: "empty", Name: "没有提示词"},
	}}}
	normalizePlugin(&p)
	if len(p.Contributes.Agents) != 1 || p.Contributes.Agents[0].ID != "review" {
		t.Fatalf("agents = %+v", p.Contributes.Agents)
	}
	if len(p.Warnings) < 2 {
		t.Fatalf("warnings = %v", p.Warnings)
	}
}

// TestPluginHooks checks a manifest's hooks are limited to safe actions
// and known events.
func TestPluginHooks(t *testing.T) {
	p := plugin{ID: "team", Contributes: pluginContrib{Hooks: map[string][]pluginAction{
		"session.opened":  {{Type: "command", Command: "sidebar"}},
		"session.created": {{Type: "command", Command: "sidebar"}},
		"turn.start":      {{Type: "command", Command: "sidebar"}},
		"turn.done":       {{Type: "url", URL: "https://example.com/?s=${event:session}"}},
		"plan.finished":   {{Type: "command", Command: "sidebar"}},
		"git.commit":      {{Type: "url", URL: "https://example.com/commit"}},
		"image.generated": {{Type: "command", Command: "sidebar"}},
		"session.deleted": {{Type: "command", Command: "sidebar"}},
		"theme.changed":   {{Type: "prompt", Prompt: "no"}, {Type: "theme", Theme: "dark"}},
		"bogus":           {{Type: "url", URL: "https://example.com"}},
	}}}
	normalizePlugin(&p)
	if len(p.Contributes.Hooks["session.opened"]) != 1 || len(p.Contributes.Hooks["turn.done"]) != 1 {
		t.Fatalf("hooks = %+v", p.Contributes.Hooks)
	}
	for _, name := range []string{"session.created", "turn.start", "plan.finished", "git.commit", "image.generated", "session.deleted"} {
		if len(p.Contributes.Hooks[name]) != 1 {
			t.Fatalf("%s hook = %+v", name, p.Contributes.Hooks[name])
		}
	}
	if len(p.Contributes.Hooks["theme.changed"]) != 1 || p.Contributes.Hooks["theme.changed"][0].Type != "theme" {
		t.Fatalf("theme hooks = %+v", p.Contributes.Hooks["theme.changed"])
	}
	if _, ok := p.Contributes.Hooks["bogus"]; ok {
		t.Fatal("an unknown event stayed")
	}
	if len(p.Warnings) < 2 {
		t.Fatalf("warnings = %v", p.Warnings)
	}
}

// TestEventText checks ${setting:key} and ${event:key} in one text.
func TestEventText(t *testing.T) {
	a := &app{cfg: config{PluginSettings: map[string]string{"team/lang": "en"}}}
	p := plugin{ID: "team", Contributes: pluginContrib{Settings: []pluginSetting{{Key: "lang", Default: "zh"}}}}
	got := a.expandPluginTextFor(p, "说 ${setting:lang}，会话 ${event:title}", map[string]string{"title": "T"})
	if got != "说 en，会话 T" {
		t.Fatalf("text = %q", got)
	}
}

// TestEventBus checks subscribers run in order with the event's data.
func TestEventBus(t *testing.T) {
	a := &app{}
	var got []string
	a.on("x", func(ev appEvent) { got = append(got, ev.Data["v"]) })
	a.on("x", func(appEvent) { got = append(got, "second") })
	a.emit("x", appEvent{Data: map[string]string{"v": "1"}})
	if strings.Join(got, ",") != "1,second" {
		t.Fatalf("got = %v", got)
	}
}

// TestPluginHookCommand runs a plugin hook when a session opens.
func TestPluginHookCommand(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"hook","name":"钩子插件","version":"1.0.0","contributes":{"hooks":{"session.opened":[{"type":"command","command":"sidebar"}]}}}`
	if err := os.WriteFile(filepath.Join(dir, "hook.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "钩子项目", Expanded: true}},
		Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	// Plugins load in the background; wait until this one is listed.
	app.WaitFor("id:welcome-primary", 10*time.Second)
	app.Press("label:设置")
	app.Press("id:settings-tab-addons")
	app.WaitFor("text:钩子插件", 15*time.Second)
	app.Press("id:settings-done")
	app.WaitForGone("id:settings-tab-addons", 5*time.Second)
	// Opening the first session runs the hook, which toggles the sidebar off.
	app.Press("id:welcome-primary")
	app.WaitForGone("id:sidebar-panel", 5*time.Second)
	app.Key("mod+b")
	app.WaitFor("id:sidebar-panel", 5*time.Second)
}

// TestPluginAgentPicker starts a session with an agent a plugin brings.
func TestPluginAgentPicker(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	dir := filepath.Join(home, "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"team","name":"团队插件","version":"1.0.0","contributes":{"agents":[{"id":"review","name":"团队审查","description":"按团队规则","prompt":"按团队规则审查。"}]}}`
	if err := os.WriteFile(filepath.Join(dir, "team.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := json.Marshal(config{Version: 2, Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_V2_HOME", home)
	t.Cleanup(closeAllPi)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.WaitFor("id:welcome-chat", 10*time.Second)
	app.Press("id:rail-palette")
	app.Type("label:命令", "智能体")
	app.WaitFor("text:用智能体新建会话…", 5*time.Second)
	app.Press("text:用智能体新建会话…")
	app.WaitFor("id:agent-dialog", 5*time.Second)
	app.WaitUntil(15*time.Second, func() bool { return len(app.Query("role:button 团队审查")) > 0 })
	app.Press("role:button 团队审查")
	app.WaitFor("id:persona-chip", 20*time.Second)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:团队审查")) > 0 })
}

// TestPluginHookSessionCreated runs a hook when a session is made, which
// is a different moment from opening one.
func TestPluginHookSessionCreated(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"created","name":"新会话钩子","version":"1.0.0","contributes":{"hooks":{"session.created":[{"type":"command","command":"sidebar"}]}}}`
	if err := os.WriteFile(filepath.Join(dir, "created.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "新会话项目", Expanded: true}},
		Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.WaitFor("id:welcome-primary", 10*time.Second)
	app.Press("label:设置")
	app.Press("id:settings-tab-addons")
	app.WaitFor("text:新会话钩子", 15*time.Second)
	app.Press("id:settings-done")
	app.WaitForGone("id:settings-tab-addons", 5*time.Second)
	// Making the first session runs the hook, which toggles the sidebar off.
	app.Press("id:welcome-primary")
	app.WaitForGone("id:sidebar-panel", 5*time.Second)
}

// TestPluginManifestOpen opens a plugin's file from the addons page.
func TestPluginManifestOpen(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	dir := filepath.Join(home, "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"team","name":"团队插件","version":"1.0.0","contributes":{"commands":[{"id":"go","title":"走","action":{"type":"prompt","prompt":"x"}}]}}`
	if err := os.WriteFile(filepath.Join(dir, "team.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.Press("label:设置")
	app.Press("id:settings-tab-addons")
	app.WaitFor("id:plugin-open-team", 10*time.Second)
	app.Press("id:plugin-open-team")
	app.WaitFor("id:editor", 5*time.Second)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:团队插件")) > 0 })
}

// TestSettingsToggles checks the settings switches actually change and show
// their new state: their value lives in the config, not a signal, so the
// page has to redraw itself after a switch.
func TestSettingsToggles(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-general")
	app.WaitFor("id:close-to-tray", 5*time.Second)
	for _, id := range []string{"close-to-tray", "notify-done", "notify-hidden"} {
		for round := 0; round < 2; round++ {
			before := app.Find("id:" + id).Props.Checked
			app.Press("id:" + id)
			app.Advance(100 * time.Millisecond)
			after := app.Find("id:" + id).Props.Checked
			if before == after {
				t.Fatalf("%s round %d: the switch stayed at %v after pressing it", id, round, before)
			}
		}
	}
}

// TestSettingsKeepScroll checks that flipping a switch keeps the settings
// page where the reader left it: the redraw makes a new scroll view, and a
// page that jumped to the top would look like it lost the press.
func TestSettingsKeepScroll(t *testing.T) {
	dir := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A window close to the dialog's old height: the settings page has to
	// be taller than the page area for the scroll to mean anything.
	app := startApp(t, dir, 1280, 620)
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-general", 5*time.Second)
	app.Press("id:settings-tab-general")
	app.WaitFor("id:settings-page", 5*time.Second)
	app.Scroll("id:settings-page", 300)
	app.Advance(200 * time.Millisecond)
	before := app.Find("id:settings-page").Offset.Y
	if before <= 0 {
		t.Skip("the page does not scroll in this window")
	}
	app.Press("id:close-to-tray")
	app.Advance(200 * time.Millisecond)
	after := app.Find("id:settings-page").Offset.Y
	if after != before {
		t.Fatalf("the page scrolled from %v to %v after a switch", before, after)
	}
}
