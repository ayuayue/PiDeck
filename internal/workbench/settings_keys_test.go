//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestSettingsKeysEditing(t *testing.T) {
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.openSettingsSection("keys")
	})
	screen.WaitFor("id:keys-search", 5*time.Second)
	if screen.Enabled("id:keys-reset-all") {
		t.Fatal("reset-all is enabled without user overrides")
	}

	// Searching must retain focus as each character rebuilds only the list.
	screen.Type("id:keys-search", "new-session")
	screen.WaitFor("id:key-new-session", 5*time.Second)
	if len(screen.QueryMounted("id:key-chat-session")) != 0 {
		t.Fatal("command search still shows an unrelated shortcut")
	}
	screen.Clear("id:key-new-session")
	screen.Type("id:key-new-session", "ctrl+alt+9")
	screen.Focus("id:keys-search")
	waitSettingsKeyConfig(t, screen, "new-session", "ctrl+alt+9", true)
	screen.Press("id:keys-modified-only")
	screen.WaitFor("id:key-new-session", 5*time.Second)

	// A rejected draft stays visible with the command's human-readable name;
	// the previous binding remains saved and active.
	screen.Clear("id:key-new-session")
	screen.Type("id:key-new-session", "mod+p")
	screen.Submit("id:key-new-session")
	screen.WaitFor("id:key-error-new-session", 5*time.Second)
	if message := screen.Find("id:key-error-new-session").Text; !strings.Contains(message, "打开命令面板") {
		t.Fatalf("conflict does not identify the other command: %q", message)
	}
	waitSettingsKeyConfig(t, screen, "new-session", "ctrl+alt+9", true)
	var previousBinding, occupiedBinding string
	onNativeUI(t, screen, built, func() {
		previousBinding, occupiedBinding = built.keymap["ctrl+alt+9"], built.keymap["mod+p"]
	})
	if previousBinding != "new-session" || occupiedBinding != "palette" {
		t.Fatalf("conflict changed the active router: previous=%q occupied=%q", previousBinding, occupiedBinding)
	}
	shot(screen, "keys-redesign/conflict")

	screen.Clear("id:key-new-session")
	screen.Type("id:key-new-session", "  ctrl+alt+8  ")
	screen.Submit("id:key-new-session")
	waitSettingsKeyConfig(t, screen, "new-session", "ctrl+alt+8", true)
	screen.WaitForGone("id:key-error-new-session", 5*time.Second)
	screen.Clear("id:key-new-session")
	screen.Focus("id:keys-search")
	waitSettingsKeyConfig(t, screen, "new-session", "", true)
	screen.WaitFor("text:未绑定 · 默认：mod+n", 5*time.Second)
	shot(screen, "keys-redesign/unbound")

	screen.Press("id:key-reset-new-session")
	waitSettingsKeyConfig(t, screen, "new-session", "", false)
	screen.WaitFor("id:keys-empty", 5*time.Second)
	screen.Press("id:keys-clear-filters")
	screen.WaitFor("id:key-palette", 5*time.Second)

	// Key searches accept case and whitespace without changing saved syntax.
	screen.Type("id:keys-search", "Ctrl + Tab")
	screen.WaitFor("id:key-next-tab", 5*time.Second)
	if len(screen.QueryMounted("id:key-new-session")) != 0 {
		t.Fatal("key search still shows an unrelated shortcut")
	}
	screen.Press("id:keys-clear-search")
	screen.Type("id:keys-search", "no-such-shortcut")
	screen.WaitFor("id:keys-empty", 5*time.Second)
	shot(screen, "keys-redesign/empty")
	screen.Press("id:keys-clear-filters")

	// Reset all includes overrides outside the current search, with a chance
	// to cancel before discarding them.
	onNativeUI(t, screen, built, func() {
		built.setKeybinding("new-session", "ctrl+alt+9")
		built.setKeybinding("settings", "")
	})
	screen.Type("id:keys-search", "new-session")
	screen.Press("id:keys-modified-only")
	screen.Press("id:keys-reset-all")
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	screen.Press("id:confirm-cancel")
	waitSettingsKeyConfig(t, screen, "new-session", "ctrl+alt+9", true)
	waitSettingsKeyConfig(t, screen, "settings", "", true)
	screen.Press("id:keys-reset-all")
	screen.Press("id:confirm-ok")
	waitSettingsKeyConfig(t, screen, "new-session", "", false)
	waitSettingsKeyConfig(t, screen, "settings", "", false)
	screen.WaitFor("id:keys-empty", 5*time.Second)
	if screen.Enabled("id:keys-reset-all") {
		t.Fatal("reset-all stays enabled after clearing every override")
	}
}

func waitSettingsKeyConfig(t *testing.T, screen *nsgotest.App, command, value string, present bool) {
	t.Helper()
	path := filepath.Join(os.Getenv("PIDECK_V2_HOME"), "config.json")
	screen.WaitUntil(5*time.Second, func() bool {
		raw, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		var saved config
		if json.Unmarshal(raw, &saved) != nil {
			return false
		}
		actual, exists := saved.Keybindings[command]
		return exists == present && (!present || actual == value)
	})
}

func TestNativeSettingsKeysScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.openSettingsSection("keys")
	})
	screen.WaitFor("id:key-palette", 5*time.Second)
	shot(screen, "keys-redesign/light")
	onNativeUI(t, screen, built, func() {
		built.theme.Set("dark")
		built.applyTheme()
	})
	shot(screen, "keys-redesign/dark")
	screen.Resize(900, 640)
	screen.WaitFor("id:key-palette", 5*time.Second)
	shot(screen, "keys-redesign/narrow-dark")
	page := screen.Find("id:settings-page").Bounds()
	for _, selector := range []string{"id:keys-search", "id:keys-modified-only", "id:keys-reset-all", "id:key-palette", "id:key-reset-palette"} {
		bounds := screen.Find(selector).Bounds()
		if bounds.Origin.X < page.Origin.X || bounds.Origin.X+bounds.Size.Width > page.Origin.X+page.Size.Width-viewkit.PanelInset+1 {
			t.Errorf("%s exceeds the page's inner gutter: page=%+v control=%+v", selector, page, bounds)
		}
	}
	onNativeUI(t, screen, built, func() { built.setLanguage("fr-FR") })
	screen.WaitFor("id:keys-search", 5*time.Second)
	shot(screen, "keys-redesign/narrow-french")
}
