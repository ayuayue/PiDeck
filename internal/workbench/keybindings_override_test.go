//go:build !js && !android && !ios

package workbench

import (
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestPluginKeybindingsRespectUserOverrides(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("key resolution needs no platform window")
	}
	for _, tc := range []struct {
		name                     string
		user                     map[string]string
		wantReview, wantSettings string
	}{
		{"defaults", nil, "ctrl+alt+r", "ctrl+alt+s"},
		{"unbound", map[string]string{"plugin:team:review": "", "settings": " "}, "", ""},
		{"rebound", map[string]string{"plugin:team:review": "ctrl+alt+v", "settings": "ctrl+alt+w"}, "ctrl+alt+v", "ctrl+alt+w"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var keys map[string]string
			var all []keyBinding
			nsgotest.Start(t, func(cx *core.Scope) core.Node {
				plugins := []plugin{{ID: "team", Name: "Team", Contributes: pluginContrib{
					Commands:    []pluginCommand{{ID: "review"}},
					Keybindings: []pluginKeybinding{{Command: "review", Key: "ctrl+alt+r"}, {Command: "settings", Key: "ctrl+alt+s"}},
				}}}
				plugins = append(plugins, plugin{ID: "fallback", Name: "Fallback", Contributes: pluginContrib{
					Keybindings: []pluginKeybinding{{Command: "check", Key: "ctrl+alt+r"}},
				}})
				a := &app{cfg: config{Keybindings: tc.user}, plugins: core.NewSignalFunc(cx, plugins, nil)}
				keys, all, _ = a.resolveKeybindings()
				if _, overridden := tc.user["plugin:team:review"]; overridden && keys["ctrl+alt+r"] != "plugin:fallback:check" {
					t.Error("the overridden plugin still reserves its original key")
				}
				return core.View{}
			})
			for command, want := range map[string]string{"plugin:team:review": tc.wantReview, "settings": tc.wantSettings} {
				for key, actual := range keys {
					if actual == command && key != want && !(tc.user == nil && key == "mod+," && command == "settings") {
						t.Errorf("%s still responds to %q; wanted %q", command, key, want)
					}
				}
				if want != "" && keys[want] != command {
					t.Errorf("%q = %q, want %s", want, keys[want], command)
				}
				if want == "" {
					listed := false
					for _, binding := range all {
						listed = listed || (binding.Command == command && binding.Source == "用户" && binding.Key == "")
					}
					if !listed {
						t.Errorf("unbound command %s disappeared from the settings entries", command)
					}
				}
				if _, overridden := tc.user[command]; overridden {
					for _, binding := range all {
						if binding.Command == command && binding.Source == "Team" {
							t.Errorf("user override still lists plugin binding: %+v", binding)
						}
					}
				}
			}
		})
	}
}
