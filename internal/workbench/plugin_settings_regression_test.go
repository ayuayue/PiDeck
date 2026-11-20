//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"maps"
	"math"
	"os"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func TestPluginSettingsRejectInvalidDefaults(t *testing.T) {
	for _, tc := range []struct {
		name, kind string
		value      any
	}{
		{"string object", "string", map[string]any{"private": "value"}},
		{"string number", "string", 12},
		{"bool string", "bool", "true"},
		{"bool number", "bool", 1},
		{"number text", "number", "12"},
		{"number nan", "number", math.NaN()},
		{"number infinity", "number", math.Inf(1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := plugin{ID: "team", Contributes: pluginContrib{Settings: []pluginSetting{
				{Key: "bad", Label: "Bad", Type: tc.kind, Default: tc.value},
				{Key: "good", Label: "Good", Default: "usable"},
			}}}
			normalizePlugin(&p)
			if len(p.Contributes.Settings) != 1 || p.Contributes.Settings[0].Key != "good" || len(p.Warnings) == 0 {
				t.Fatalf("invalid default was retained or broke its neighbor: %+v", p)
			}
		})
	}
}

func TestPluginSettingsUseTypedDefaultsWithoutRewritingSavedValues(t *testing.T) {
	p := plugin{ID: "team", Contributes: pluginContrib{Settings: []pluginSetting{
		{Key: "flag", Label: "Flag", Type: "bool"},
		{Key: "count", Label: "Count", Type: "number"},
		{Key: "text", Label: "Text", Type: "string"},
		{Key: "style", Label: "Style", Type: "select", Options: []string{"plain", "warm"}},
	}}}
	normalizePlugin(&p)
	saved := map[string]string{"team/flag": "yes", "team/count": "NaN", "team/text": "hello", "team/style": "unknown", "team/hidden": "private"}
	before := map[string]string{}
	for key, value := range saved {
		before[key] = value
	}
	for key, want := range map[string]string{"flag": "false", "count": "0", "text": "hello", "style": "plain", "hidden": ""} {
		if got := pluginSettingValue(saved, p, key); got != want {
			t.Errorf("%s=%q, want %q", key, got, want)
		}
	}
	if !maps.Equal(saved, before) {
		t.Fatalf("reading rewrote saved values: got=%v, want=%v", saved, before)
	}
	for _, value := range []string{"-2.5", "1e3", "0"} {
		saved["team/count"] = value
		if got := pluginSettingValue(saved, p, "count"); got != value {
			t.Errorf("valid number %q became %q", value, got)
		}
	}
}

func TestPluginSettingWritesRequireDeclaredValidValue(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { waitPluginConfigWrites(t) })
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		p := plugin{ID: "team", Contributes: pluginContrib{Settings: []pluginSetting{
			{Key: "flag", Label: "Flag", Type: "bool", Default: true},
			{Key: "count", Label: "Count", Type: "number", Default: 3},
			{Key: "style", Label: "Style", Type: "select", Options: []string{"plain", "warm"}},
			{Key: "text", Label: "Text", Type: "string"},
		}}}
		normalizePlugin(&p)
		a := &app{cx: cx, st: st, cfg: st.config(), plugins: core.NewSignalFunc(cx, []plugin{p}, nil)}
		for key, value := range map[string]string{"flag": "false", "count": "-1.25e2", "style": "warm", "text": "hello"} {
			a.setPluginSetting("team", key, value)
			if got := a.cfg.PluginSettings["team/"+key]; got != value {
				t.Errorf("valid %s=%q, got %q", key, value, got)
			}
		}
		before := st.config().PluginSettings
		for _, tc := range []struct{ id, key, value string }{
			{"team", "hidden", "private"}, {"missing", "flag", "true"},
			{"team", "flag", "yes"}, {"team", "flag", "TRUE"},
			{"team", "count", "NaN"}, {"team", "count", "+Inf"},
			{"team", "count", "1e9999"}, {"team", "count", ""},
			{"team", "style", "unknown"},
		} {
			a.setPluginSetting(tc.id, tc.key, tc.value)
			if got := st.config().PluginSettings; !maps.Equal(got, before) {
				t.Errorf("invalid write %+v changed config: got=%v, want=%v", tc, got, before)
			}
		}
		if got := a.pluginSetting("missing", "flag"); got != "" {
			t.Errorf("read undeclared plugin value=%q", got)
		}
		return nil
	})
	waitPluginConfigSaved(t, screen, st)
}

func TestPluginNumberSettingAllowsIntermediateInputAndRefusesInvalidCommit(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { waitPluginConfigWrites(t) })
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		p := plugin{ID: "team", Contributes: pluginContrib{Settings: []pluginSetting{
			{Key: "count", Label: "Count", Type: "number", Default: 3},
		}}}
		normalizePlugin(&p)
		a = &app{cx: cx, st: st, cfg: st.config(), plugins: core.NewSignalFunc(cx, []plugin{p}, nil)}
		return a.pluginSettingControl(p, p.Contributes.Settings[0])
	})
	selector := "id:plugin-setting-team-count"
	screen.Clear(selector)
	screen.Type(selector, "-")
	if got := a.pluginSetting("team", "count"); got != "3" {
		t.Fatalf("intermediate input persisted: %q", got)
	}
	screen.Submit(selector)
	screen.WaitFor("id:plugin-setting-team-count-error", 5*time.Second)
	if got := a.pluginSetting("team", "count"); got != "3" {
		t.Fatalf("invalid input persisted: %q", got)
	}
	screen.Type(selector, "2.5")
	screen.Submit(selector)
	if got := a.pluginSetting("team", "count"); got != "-2.5" {
		t.Fatalf("valid negative decimal=%q, want -2.5", got)
	}
	if screen.Exists("id:plugin-setting-team-count-error") {
		t.Fatal("error remained after a valid commit")
	}
	waitPluginConfigSaved(t, screen, st)
}

func waitPluginConfigSaved(t *testing.T, screen *nsgotest.App, st *store) {
	t.Helper()
	waitPluginConfigWrites(t)
	want := st.config()
	screen.WaitUntil(5*time.Second, func() bool {
		raw, err := os.ReadFile(st.path)
		var saved config
		return err == nil && json.Unmarshal(raw, &saved) == nil &&
			saved.PluginIndexURL == want.PluginIndexURL && maps.Equal(saved.PluginSettings, want.PluginSettings)
	})
}

func waitPluginConfigWrites(t *testing.T) {
	t.Helper()
	finished := make(chan struct{})
	go func() { pluginConfigWrites.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("accepted plugin config writes did not finish")
	}
}

func TestPluginSettingSaveFailureIsVisible(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { waitPluginConfigWrites(t) })
	// A directory cannot be replaced by the config file. No real user file
	// or permissions are involved, and this fails on all desktop platforms.
	st.path = st.dir
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		p := plugin{ID: "team", Contributes: pluginContrib{Settings: []pluginSetting{
			{Key: "text", Label: "Text", Type: "string"},
		}}}
		normalizePlugin(&p)
		a := &app{cx: cx, st: st, cfg: st.config(), plugins: core.NewSignalFunc(cx, []plugin{p}, nil), toaster: ui.NewToaster(cx)}
		if !a.setPluginSetting("team", "text", "hello") {
			t.Fatal("valid setting was rejected before saving")
		}
		return ui.Toasts{Toaster: a.toaster}
	})
	screen.WaitFor("text:保存失败", 5*time.Second)
	if got, err := os.Stat(st.dir); err != nil || !got.IsDir() {
		t.Fatalf("failed save changed destination directory: info=%v, err=%v", got, err)
	}
}
