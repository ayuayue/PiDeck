package main

// Checks for the key table: defaults, a user's replacements, plugin
// keys, and the spellings that must compare equal.

import (
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestNormalizeKey checks the names two spellings share.
func TestNormalizeKey(t *testing.T) {
	cases := map[string]string{
		"Mod+Shift+G":     "mod+shift+g",
		"cmd + shift + g": "shift+meta+g",
		"control+tab":     "ctrl+tab",
		"option+left":     "alt+left",
		"  F5  ":          "f5",
		"":                "",
	}
	for in, want := range cases {
		if got := normalizeKey(in); got != want {
			t.Errorf("normalizeKey(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestDefaultKeybindings checks every default names a real command and
// that two defaults do not share a key.
func TestDefaultKeybindings(t *testing.T) {
	seen := map[string]string{}
	for _, b := range defaultKeybindings() {
		if !isBuiltinCommand(b.Command) {
			t.Errorf("default binding %q names no command", b.Command)
		}
		k := normalizeKey(b.Key)
		if other, dup := seen[k]; dup {
			t.Errorf("%s and %s share %s", b.Command, other, b.Key)
		}
		seen[k] = b.Command
	}
}

// TestResolveKeybindings checks user overrides and explicit unbinding.
func TestResolveKeybindings(t *testing.T) {
	a := &app{cfg: config{Keybindings: map[string]string{
		"new-session": "ctrl+alt+n",
		"settings":    "",
	}}}
	keyToCmd, all, conflicts := a.resolveKeybindings()
	if len(conflicts) != 0 {
		t.Fatalf("conflicts = %v", conflicts)
	}
	if keyToCmd["ctrl+alt+n"] != "new-session" {
		t.Fatalf("override missing: %v", keyToCmd)
	}
	if _, ok := keyToCmd["mod+n"]; ok {
		t.Fatalf("the old key still runs new-session: %v", keyToCmd)
	}
	if _, ok := keyToCmd["mod+,"]; ok {
		t.Fatalf("an empty user key should unbind settings: %v", keyToCmd)
	}
	found := false
	for _, b := range all {
		if b.Command == "new-session" && b.Source == "用户" {
			found = true
		}
	}
	if !found {
		t.Fatalf("user source missing: %+v", all)
	}
}

// TestResolveKeybindingConflict checks that a user's key cannot take
// another command's key.
func TestResolveKeybindingConflict(t *testing.T) {
	a := &app{cfg: config{Keybindings: map[string]string{"drawer": "mod+k"}}}
	keyToCmd, _, conflicts := a.resolveKeybindings()
	if keyToCmd["mod+k"] != "palette" {
		t.Fatalf("mod+k should stay with palette: %v", keyToCmd)
	}
	if len(conflicts) == 0 || !strings.Contains(conflicts[0], "mod+k") {
		t.Fatalf("conflicts = %v", conflicts)
	}
}

// TestKeybindingRouter checks a key reaches its command through the
// router the app binds at startup.
func TestKeybindingRouter(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Key("mod+k")
	app.WaitFor("text:搜索命令、会话或工作区…", 5*time.Second)
	app.Key("escape")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(app.Query("text:搜索命令、会话或工作区…")) == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("escape did not close the palette")
}

// TestPluginKeybindings checks plugin keys take free keys only, and that
// a plugin-local command id gets its plugin's prefix.
func TestPluginKeybindings(t *testing.T) {
	base := map[string]string{"mod+k": "palette"}
	plugins := []plugin{
		{ID: "team", Name: "团队", Contributes: pluginContrib{Keybindings: []pluginKeybinding{
			{Command: "review", Key: "mod+shift+r"},
			{Command: "settings", Key: "mod+alt+s"},
			{Command: "clash", Key: "mod+k"},
		}}},
		{ID: "off", Name: "停用", Disabled: true, Contributes: pluginContrib{Keybindings: []pluginKeybinding{
			{Command: "x", Key: "mod+alt+x"},
		}}},
	}
	added, conflicts := resolvePluginKeybindings(base, plugins)
	if base["mod+shift+r"] != "plugin:team:review" {
		t.Fatalf("plugin-local command not prefixed: %v", base)
	}
	if base["mod+alt+s"] != "settings" {
		t.Fatalf("built-in target should stay bare: %v", base)
	}
	if _, ok := base["mod+alt+x"]; ok {
		t.Fatalf("a disabled plugin bound a key: %v", base)
	}
	if len(added) != 2 {
		t.Fatalf("added = %+v", added)
	}
	if len(conflicts) != 1 || !strings.Contains(conflicts[0], "团队") {
		t.Fatalf("conflicts = %v", conflicts)
	}
}
