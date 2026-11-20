//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestPluginDuplicateIDsKeepIdentityAndBlockAllContributions(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(st.dir, "plugins")
	if err := os.MkdirAll(filepath.Join(dir, "copy"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"id":"team","name":"Team","themes":[{"name":"Team theme"}],"contributes":{"commands":[{"id":"change","title":"Change","action":{"type":"prompt","prompt":"changed"}}],"settings":[{"key":"tone","label":"Tone","default":"plain"}],"keybindings":[{"command":"change","key":"mod+alt+y"}],"agents":[{"id":"writer","name":"Writer","prompt":"Write"}],"hooks":{"plan.finished":[{"type":"command","command":"chat-outline"}]}}}`)
	paths := []string{filepath.Join(dir, "team.json"), filepath.Join(dir, "copy", "plugin.json")}
	for _, path := range paths {
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	a := &app{st: st, cfg: st.config()}
	plugins := a.loadPlugins()
	if len(plugins) != 2 {
		t.Fatalf("plugins=%+v, want two visible conflicts", plugins)
	}
	for _, p := range plugins {
		if p.ID != "team" || p.Error == "" {
			t.Errorf("conflict ID=%q, error=%q; want unchanged ID and visible error", p.ID, p.Error)
		}
	}
	if added, _ := resolvePluginKeybindings(map[string]string{}, plugins); len(added) != 0 {
		t.Errorf("conflicting plugins bound keys: %+v", added)
	}
	for _, th := range a.loadThemes(plugins) {
		if th.ID == "plugin:team:0" {
			t.Error("conflicting plugin activated its theme")
		}
	}
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		s := &session{draft: core.NewSignal(cx, "original")}
		a.cx, a.activeID, a.byID = cx, core.NewSignal(cx, "s"), map[string]*session{"s": s}
		a.plugins = core.NewSignalFunc(cx, plugins, nil)
		a.runPluginCommand("team", "change")
		if got := s.draft.GetUntracked(); got != "original" {
			t.Errorf("conflicting plugin executed: draft=%q", got)
		}
		return a.settingsAddons()
	})
	controls := screen.Query("role:button 查看插件清单")
	if len(controls) != 2 || controls[0].Props.TestID == controls[1].Props.TestID {
		t.Fatalf("conflict repair controls must have distinct identities: %+v", controls)
	}
	if screen.Exists("id:plugin-toggle-team") || screen.Exists("id:plugin-setting-team-tone") {
		t.Fatal("conflicting plugin exposed enable or setting controls")
	}
	for _, path := range paths {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != string(body) {
			t.Fatalf("conflict rewrote manifest: %q, err=%v", got, err)
		}
	}
	if err := os.Remove(paths[1]); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Dir(paths[1])); err != nil {
		t.Fatal(err)
	}
	a.cfg.DisabledPlugins = []string{"team"}
	plugins = a.loadPlugins()
	if len(plugins) != 1 {
		t.Fatalf("plugins after resolving conflict=%+v", plugins)
	}
	var recovered bool
	for _, p := range plugins {
		if p.ID == "team" {
			recovered = p.Error == "" && p.Disabled && len(p.Commands) == 1
		}
	}
	if !recovered {
		t.Fatalf("stable identity did not recover with its disabled setting: %+v", plugins)
	}
}
