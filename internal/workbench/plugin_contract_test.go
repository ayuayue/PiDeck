//go:build !js && !android && !ios

package workbench

import (
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	yaml "go.yaml.in/yaml/v3"
)

func TestPluginManifestRuntimeCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name, fields string
		wantError    bool
	}{
		{"legacy", "", false},
		{"explicit v2", `"schemaVersion":2,"runtime":"pideck-v2",`, false},
		{"electron", `"schemaVersion":1,"runtime":"pideck-electron",`, true},
		{"future schema", `"schemaVersion":99,"runtime":"pideck-v2",`, true},
		{"unknown runtime", `"runtime":"future-runtime",`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := `{` + tc.fields + `"id":"team","name":"Team","contributes":{"commands":[{"id":"hello","title":"Hello","action":{"type":"prompt","prompt":"hello"}}]}}`
			var p plugin
			if err := yaml.Unmarshal([]byte(raw), &p); err != nil {
				t.Fatal(err)
			}
			normalizePlugin(&p)
			if got := p.Error != ""; got != tc.wantError {
				t.Fatalf("error=%q, wantError=%v", p.Error, tc.wantError)
			}
			if tc.wantError && len(p.Commands) != 0 {
				t.Fatalf("incompatible manifest activated commands: %+v", p.Commands)
			}
		})
	}
}

func TestPluginCommandCannotDelegateToPluginOrPaletteRoute(t *testing.T) {
	for _, command := range []string{"plugin:team:loop", "theme:dark", "file:secret", "missing"} {
		if err := validateAction(pluginAction{Type: "command", Command: command}); err == nil {
			t.Errorf("accepted non-builtin command %q", command)
		}
	}
	if err := validateAction(pluginAction{Type: "command", Command: "compact"}); err != nil {
		t.Fatalf("rejected builtin command: %v", err)
	}
	p := plugin{Contributes: pluginContrib{Hooks: map[string][]pluginAction{
		eventTurnDone: {{Type: "command", Command: "plugin:team:send"}},
	}}}
	normalizePlugin(&p)
	if len(p.Contributes.Hooks) != 0 {
		t.Fatalf("hook retained a plugin command: %+v", p.Contributes.Hooks)
	}
}

func TestPluginHooksCannotStartTurnsThroughBuiltins(t *testing.T) {
	for _, id := range []string{"compact", "new-session", "fork-last", "delete", "terminal-new"} {
		p := plugin{Contributes: pluginContrib{Hooks: map[string][]pluginAction{
			eventTurnDone: {{Type: "command", Command: id}},
		}}}
		normalizePlugin(&p)
		if len(p.Contributes.Hooks) != 0 || len(p.Warnings) == 0 {
			t.Errorf("hook retained builtin %q: %+v", id, p)
		}
	}
	for _, id := range []string{"sidebar", "drawer", "git-refresh", "chat-outline"} {
		if !pluginHookCommandAllowed(id) {
			t.Errorf("safe builtin %q is not available to hooks", id)
		}
	}
}

func TestPluginBuiltinAvailabilityAndInterpolatedHookTarget(t *testing.T) {
	var opened bool
	nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a := &app{cx: cx, activeID: core.NewSignal(cx, ""), agentOpen: core.NewSignal(cx, false), agentApply: core.NewSignal(cx, false)}
		p := plugin{ID: "team", Contributes: pluginContrib{Settings: []pluginSetting{{Key: "target", Default: "new-session"}}}}
		// agent-bind is unavailable without an active session.
		a.runPluginActionFor(p, pluginCommand{Action: pluginAction{Type: "command", Command: "agent-bind"}}, nil, nil)
		opened = a.agentOpen.GetUntracked()
		// Static validation cannot see this target. The execution-time hook
		// check must refuse it before it can create a session or read app UI.
		a.inHook = true
		a.runPluginActionFor(p, pluginCommand{Action: pluginAction{Type: "command", Command: "${setting:target}"}}, nil, nil)
		return nil
	})
	if opened {
		t.Fatal("ran a builtin whose availability condition was false")
	}
}

func TestPluginDisabledCommandCannotRunByID(t *testing.T) {
	for _, tc := range []struct {
		name, loadError string
		disabled        bool
		want            string
	}{
		{name: "enabled", want: "changed"},
		{name: "disabled", disabled: true, want: "original"},
		{name: "invalid", loadError: "invalid manifest", want: "original"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got string
			nsgotest.Start(t, func(cx *core.Scope) core.Node {
				s := &session{draft: core.NewSignal(cx, "original")}
				p := plugin{ID: "team", Disabled: tc.disabled, Error: tc.loadError,
					Commands: []pluginCommand{{ID: "change", Action: pluginAction{Type: "prompt", Prompt: "changed"}}}}
				a := &app{cx: cx, activeID: core.NewSignal(cx, "s"), byID: map[string]*session{"s": s},
					plugins: core.NewSignalFunc(cx, []plugin{p}, nil)}
				a.runPluginCommand("team", "change")
				got = s.draft.GetUntracked()
				return core.Text{Content: got}
			})
			if got != tc.want {
				t.Fatalf("draft=%q, want %q", got, tc.want)
			}
		})
	}
}
