//go:build !js && !android && !ios

package workbench

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

// TestKeybindingsMatchElectron pins the keys the Electron release uses,
// so a later change cannot quietly part company with the habits people
// bring from it. Only the keys that release actually binds are here.
func TestKeybindingsMatchElectron(t *testing.T) {
	want := map[string]string{
		"palette":         "mod+p",       // Ctrl+P: the command palette
		"new-session":     "mod+n",       // Ctrl+N
		"search-sessions": "mod+f",       // Ctrl+F: across every session
		"chat-find":       "mod+shift+f", // Ctrl+Shift+F: inside this one
		"cycle-model":     "ctrl+m",      // Ctrl+M: next starred model
		"cycle-thinking":  "ctrl+t",      // Ctrl+T: next thinking level
		"next-tab":        "ctrl+tab",    // Ctrl+Tab
		"prev-tab":        "ctrl+shift+tab",
		"close-tab":       "mod+w",
		"save-file":       "mod+s",
		"settings":        "mod+,",
	}
	got := map[string]string{}
	for _, b := range defaultKeybindings() {
		got[b.Command] = normalizeKey(b.Key)
	}
	for cmd, key := range want {
		if got[cmd] != key {
			t.Errorf("%s = %q, want the Electron release's %q", cmd, got[cmd], key)
		}
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
	a := &app{cfg: config{Keybindings: map[string]string{"drawer": "mod+p"}}}
	keyToCmd, _, conflicts := a.resolveKeybindings()
	if keyToCmd["mod+p"] != "palette" {
		t.Fatalf("mod+p should stay with palette: %v", keyToCmd)
	}
	if len(conflicts) == 0 || !strings.Contains(conflicts[0], "mod+p") {
		t.Fatalf("conflicts = %v", conflicts)
	}
}

// TestKeybindingRouter checks a key reaches its command through the
// router the app binds at startup.
func TestKeybindingRouter(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Key("mod+p")
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
	base := map[string]string{"mod+p": "palette"}
	plugins := []plugin{
		{ID: "team", Name: "团队", Contributes: pluginContrib{Commands: []pluginCommand{{ID: "review", Title: "团队审查"}}, Keybindings: []pluginKeybinding{
			{Command: "review", Key: "mod+shift+r"},
			{Command: "settings", Key: "mod+alt+s"},
			{Command: "clash", Key: "mod+p"},
		}}},
		{ID: "off", Name: "停用", Disabled: true, Contributes: pluginContrib{Keybindings: []pluginKeybinding{
			{Command: "x", Key: "mod+alt+x"},
		}}},
	}
	added, conflicts := resolvePluginKeybindings(base, plugins, nil)
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
