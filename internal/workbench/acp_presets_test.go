//go:build !js && !android && !ios

package workbench

// Checks custom ACP presets load from the data folder.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestDSHUsesPublishedACPProfile(t *testing.T) {
	for _, preset := range acpPresets() {
		if preset.ID == "dsh" {
			if preset.Command != "dsh" || !slices.Equal(preset.Args, []string{"--profile", "acp"}) || preset.Install != "@deepseek-ai/dsh" {
				t.Fatalf("DSH preset launches the wrong profile: %+v", preset)
			}
			return
		}
	}
	t.Fatal("DSH ACP preset is missing")
}

func TestACPPresetInstallFromBuiltinOnly(t *testing.T) {
	args, ok := acpPresetInstallArgs("dsh")
	if want := []string{"install", "--global", "--no-audit", "--no-fund", "@deepseek-ai/dsh"}; !ok || !slices.Equal(args, want) {
		t.Fatalf("install args = %v, %v, want %v", args, ok, want)
	}
	for _, id := range []string{"custom", "qoder", "claude", "--global", "@deepseek-ai/dsh"} {
		if args, ok := acpPresetInstallArgs(id); ok || len(args) != 0 {
			t.Errorf("%q can launch an installer: %v", id, args)
		}
	}
}

// TestACPPresetList checks files add presets, bad entries are skipped and
// built-ins stay.
func TestACPPresetList(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	acpDir := filepath.Join(dir, "acp")
	if err := os.MkdirAll(acpDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"presets":[
		{"id":"mine","name":"Mine","command":"mine-acp","args":["--acp"]},
		{"id":"","name":"bad","command":"x"},
		{"id":"claude","name":"Mine Claude","command":"my-claude","args":["--acp","--fast"],
		 "env":{"ANTHROPIC_API_KEY":"secret","1nope":"x"},"bypassPermissions":true}
	]}`
	if err := os.WriteFile(filepath.Join(acpDir, "one.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	array := `[{"id":"other","name":"Other","command":"other-acp"},{"id":"mine","name":"Later","command":"later-acp"}]`
	if err := os.WriteFile(filepath.Join(acpDir, "two.json"), []byte(array), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	list := a.acpPresetList()
	byID := map[string]acpPreset{}
	for _, p := range list {
		byID[p.ID] = p
	}
	if _, ok := byID["claude"]; !ok {
		t.Fatal("the built-in Claude preset is missing")
	}
	if p, ok := byID["mine"]; !ok || p.Command != "mine-acp" || len(p.Args) != 1 {
		t.Fatalf("custom preset = %+v", p)
	}
	// Two files declaring one id: the first read wins.
	if p := byID["mine"]; p.Name != "Mine" || p.Builtin {
		t.Fatalf("a later file replaced the first entry: %+v", p)
	}
	if _, ok := byID["other"]; !ok {
		t.Fatal("a bare array file was not read")
	}
	if _, ok := byID[""]; ok {
		t.Fatal("an invalid preset was kept")
	}
	// A file entry with a built-in's id replaces what it launches and keeps
	// the docs and install line only the built-in knows.
	over := byID["claude"]
	if !over.Builtin || !over.Edited || over.Name != "Mine Claude" || over.Command != "my-claude" || len(over.Args) != 2 {
		t.Fatalf("override = %+v", over)
	}
	if over.Homepage == "" || !over.Npx || !over.BypassPermissions {
		t.Fatalf("override lost what the built-in knows: %+v", over)
	}
	if len(over.Env) != 1 || over.Env["ANTHROPIC_API_KEY"] != "secret" {
		t.Fatalf("override env = %+v, want the unusable key dropped", over.Env)
	}
	// Untouched built-ins stay as shipped.
	if gemini := byID["gemini"]; gemini.Edited || !gemini.Builtin {
		t.Fatalf("gemini = %+v", gemini)
	}
}

// TestACPPresetEnvLine checks the manager's one-line env editing.
func TestACPPresetEnvLine(t *testing.T) {
	text := "B=two; A=1; 1bad=x; C=three=four; EMPTY="
	env := acpParseEnv(text)
	if len(env) != 3 || env["A"] != "1" || env["B"] != "two" || env["C"] != "three=four" {
		t.Fatalf("env = %+v", env)
	}
	if got := acpEnvText(env); got != "A=1; B=two; C=three=four" {
		t.Fatalf("env text = %q", got)
	}
	if again := acpParseEnv(acpEnvText(env)); len(again) != len(env) {
		t.Fatalf("round trip = %+v", again)
	}
	if env := acpParseEnv("A=line1\nB=line2"); len(env) != 2 {
		t.Fatalf("multi-line env = %+v", env)
	}
}

// TestACPPresetStore checks the manager's file round-trips.
func TestACPPresetStore(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	list := []acpPreset{{ID: "mine", Name: "我的 Agent", Command: "my-agent", Args: []string{"--acp"}}}
	if err := a.saveACPPresets(list); err != nil {
		t.Fatal(err)
	}
	got := a.acpCustomPresets()
	if len(got) != 1 || got[0].ID != "mine" || got[0].Command != "my-agent" || len(got[0].Args) != 1 {
		t.Fatalf("presets = %+v", got)
	}
	if all := a.acpPresetList(); len(all) != len(acpPresets())+1 {
		t.Fatalf("the list has %d presets, want %d", len(all), len(acpPresets())+1)
	}
}

// TestACPPresetManager adds and removes a preset through the dialog.
func TestACPPresetManager(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-integrations")
	app.WaitFor("id:acp-manage-open", 5*time.Second)
	app.Press("id:acp-manage-open")
	app.WaitFor("id:acp-preset-manager", 5*time.Second)
	// Wait out the first read: the list filling in renumbers the editor's
	// fields, and typing across that would lose keystrokes.
	app.WaitFor("id:acp-preset-row-gemini", 5*time.Second)
	app.Press("id:acp-preset-new")
	app.Type("id:acp-preset-id", "mine")
	app.Type("id:acp-preset-name", "我的 Agent")
	app.Type("id:acp-preset-command", "my-agent")
	app.Type("id:acp-preset-args", "--acp --fast")
	app.Press("id:acp-preset-save")
	app.WaitFor("id:acp-preset-row-mine", 5*time.Second)
	path := filepath.Join(home, "acp", "presets.json")
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), "mine") || !strings.Contains(string(raw), "--fast") {
		t.Fatalf("presets.json = %s, %v", raw, err)
	}
	app.Press("id:acp-preset-remove-mine")
	app.WaitForGone("id:acp-preset-row-mine", 5*time.Second)
	raw, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file acpPresetFile
	if json.Unmarshal(raw, &file) != nil || len(file.Presets) != 0 {
		t.Fatalf("after removing: %s", raw)
	}
}

// TestACPPresetOverrideEditsBuiltin changes a built-in's launch parameters
// and its bypass switch, then puts it back.
func TestACPPresetOverrideEditsBuiltin(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-integrations")
	app.WaitFor("id:acp-manage-open", 5*time.Second)
	app.Press("id:acp-manage-open")
	app.WaitFor("id:acp-preset-row-claude", 5*time.Second)
	app.Press("id:acp-preset-row-claude")
	app.Clear("id:acp-preset-args")
	app.Type("id:acp-preset-args", "-y @agentclientprotocol/claude-agent-acp --verbose")
	app.Type("id:acp-preset-env", "ANTHROPIC_API_KEY=secret")
	app.Press("id:acp-preset-tab-access")
	app.Press("id:acp-preset-bypass")
	app.Press("id:acp-preset-tab-launch")
	app.Press("id:acp-preset-save")
	path := filepath.Join(home, "acp", "presets.json")
	app.WaitUntil(10*time.Second, func() bool {
		raw, err := os.ReadFile(path)
		return err == nil && strings.Contains(string(raw), "--verbose")
	})
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file acpPresetFile
	if json.Unmarshal(raw, &file) != nil || len(file.Presets) != 1 {
		t.Fatalf("presets.json = %s", raw)
	}
	over := file.Presets[0]
	if over.ID != "claude" || !slices.Equal(over.Args, []string{"-y", "@agentclientprotocol/claude-agent-acp", "--verbose"}) ||
		!over.BypassPermissions || over.Env["ANTHROPIC_API_KEY"] != "secret" {
		t.Fatalf("override = %+v", over)
	}
	// The list now shows it as the user's own copy, and reverting deletes it.
	app.WaitFor("id:acp-preset-remove-claude", 10*time.Second)
	app.Press("id:acp-preset-remove-claude")
	app.WaitUntil(10*time.Second, func() bool {
		raw, err := os.ReadFile(path)
		return err == nil && !strings.Contains(string(raw), "claude")
	})
}

// TestAcpPresetList checks the built-in presets are distinct and carry the
// metadata the settings page shows.
func TestAcpPresetList(t *testing.T) {
	list := acpPresets()
	if len(list) < 12 {
		t.Fatalf("only %d built-in presets", len(list))
	}
	seen := map[string]bool{}
	for _, p := range list {
		if p.ID == "" || p.Name == "" || p.Command == "" {
			t.Errorf("incomplete preset %+v", p)
		}
		if seen[p.ID] {
			t.Errorf("duplicate preset id %q", p.ID)
		}
		seen[p.ID] = true
		if p.Homepage == "" {
			t.Errorf("%s has no homepage", p.ID)
		}
		if p.Npx && p.Install != "" {
			t.Errorf("%s is npx and names a package to install", p.ID)
		}
		if cmd := acpPresetInstall(p); p.Npx && cmd != "" {
			t.Errorf("%s: npx preset suggests installing %q", p.ID, cmd)
		}
		if state, _ := acpPresetState(p); state == "" {
			t.Errorf("%s has no state line", p.ID)
		}
	}
	// The Qoder presets must start in bypass permissions: the adapter
	// refuses to set that option after launch.
	for _, p := range list {
		if p.ID == "qoder" || p.ID == "qoder-cn" {
			if strings.Join(p.Args, " ") != "--acp --permission-mode bypass_permissions" {
				t.Errorf("%s args = %v", p.ID, p.Args)
			}
		}
	}
}
