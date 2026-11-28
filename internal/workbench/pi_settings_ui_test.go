//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func TestPiSettingsNumbersKeepInvalidInputLocal(t *testing.T) {
	for _, mode := range []string{"light", "dark"} {
		t.Run(mode, func(t *testing.T) { testPiSettingsNumberInput(t, mode == "dark") })
	}
}

func testPiSettingsNumberInput(t *testing.T, dark bool) {
	prefix := "settings-pi-light-"
	if dark {
		prefix = "settings-pi-dark-"
	}
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_PI_CONFIG", dir)
	t.Cleanup(configWrites.Wait)
	path := filepath.Join(dir, "settings.json")
	initial := []byte(`{"retry":{"maxRetries":7},"compaction":{"reserveTokens":4096,"keepRecentTokens":2048}}`)
	if err := os.WriteFile(path, initial, 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := readPiSettings()
	if err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		cx.SetTheme(viewkit.Theme())
		cx.SetAppearance(core.AppearanceLight)
		if dark {
			cx.SetAppearance(core.AppearanceDark)
		}
		built = &app{cx: cx, piSet: s, piSetRev: core.NewSignal(cx, 0),
			piRetryText: core.NewSignal(cx, ""), piReserveText: core.NewSignal(cx, ""), piKeepText: core.NewSignal(cx, "")}
		return core.View{Style: ui.FillRest.Merge(core.Style{FontFamily: cx.Theme().Sans, Padding: core.All(16)}),
			StyleFunc: func() core.Style { return core.Style{Background: ui.ColorsOf(cx).Background()} },
			Children:  []core.Node{core.View{Style: core.Style{Width: core.Pt(420), Height: core.Pct(100)}, Children: []core.Node{built.settingsPi()}}}}
	}, nsgotest.Size(960, 640), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	screen.WaitFor("id:settings-page", 5*time.Second)
	if built.piRetryText.GetUntracked() != "7" || built.piReserveText.GetUntracked() != "4096" || built.piKeepText.GetUntracked() != "2048" {
		t.Fatal("opening pi settings did not populate the saved number fields")
	}
	if nsgotest.Target() != "" {
		screen.Screenshot(prefix + "overview")
	}
	reveal := func(id string) {
		t.Helper()
		fields := screen.QueryMounted("id:" + id)
		if len(fields) != 1 {
			t.Fatalf("field %s not mounted", id)
		}
		field, viewport := fields[0].Bounds(), screen.Find("id:settings-page").Bounds()
		if field.Origin.Y < viewport.Origin.Y || field.Origin.Y+field.Size.Height > viewport.Origin.Y+viewport.Size.Height {
			screen.Scroll("id:settings-page", field.Origin.Y-viewport.Origin.Y-80)
		}
		screen.Focus("id:" + id)
	}
	for _, tc := range []struct{ id, value string }{{"pi-retry-max", "invalid"}, {"pi-reserve-tokens", "-1"}, {"pi-keep-tokens", "3.5"}} {
		reveal(tc.id)
		screen.Clear("id:" + tc.id)
		screen.Type("id:"+tc.id, tc.value)
		screen.Submit("id:" + tc.id)
		configWrites.Wait()
		if built.piSet.RetryMax != 7 || built.piSet.ReserveTokens != 4096 || built.piSet.KeepRecentTokens != 2048 {
			t.Fatalf("invalid input %q changed settings: %+v", tc.value, built.piSet)
		}
		raw, err := os.ReadFile(path)
		if err != nil || string(raw) != string(initial) {
			t.Fatalf("invalid input %q changed the file: %s, %v", tc.value, raw, err)
		}
		screen.Find("id:" + tc.id + "-error")
		page := screen.Find("id:settings-page")
		if page.Content.Width > page.Bounds().Size.Width+1 {
			t.Fatalf("pi number input overflows the settings column: content=%v viewport=%v", page.Content, page.Bounds())
		}
		if nsgotest.Target() != "" {
			screen.Screenshot(prefix + "invalid-" + tc.id)
		}
	}
	reveal("pi-retry-max")
	screen.Clear("id:pi-retry-max")
	screen.Type("id:pi-retry-max", "9")
	// Leaving a valid number field saves it without requiring Return.
	reveal("pi-reserve-tokens")
	configWrites.Wait()
	if built.piSet.RetryMax != 9 {
		t.Fatalf("leaving the retry field did not apply the valid value: text=%q, settings=%+v", built.piRetryText.GetUntracked(), built.piSet)
	}
	reveal("pi-retry-max")
	screen.Clear("id:pi-retry-max")
	screen.Submit("id:pi-retry-max")
	configWrites.Wait()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"retry": map[string]any{}, "compaction": map[string]any{"reserveTokens": float64(4096), "keepRecentTokens": float64(2048)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("clearing retry count changed unrelated settings: %s", raw)
	}
}

func TestPiSettingsSavesQueuedEditsInOrder(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_PI_CONFIG", dir)
	t.Cleanup(configWrites.Wait)
	gate := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(gate) }) })
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = &app{cx: cx, piSet: piSettings{RetryEnabled: true, CompactionEnabled: true, saveDone: gate}, piSetRev: core.NewSignal(cx, 0)}
		return core.View{}
	}, nsgotest.Size(960, 640))
	screen.Post(func() {
		built.updatePiSettings(func(s *piSettings) { s.QuietStartup = true })
		built.updatePiSettings(func(s *piSettings) { s.RetryEnabled = false })
		built.updatePiSettings(func(s *piSettings) { s.RetryEnabled = true })
		built.updatePiSettings(func(s *piSettings) { s.ReserveTokens = 4096 })
		built.updatePiSettings(func(s *piSettings) { s.KeepRecentTokens = 2048 })
		built.updatePiSettings(func(s *piSettings) { s.ReserveTokens = 0 })
	})
	screen.WaitUntil(5*time.Second, func() bool {
		return built.piSet.QuietStartup && built.piSet.RetryEnabled && built.piSet.ReserveTokens == 0 && built.piSet.KeepRecentTokens == 2048
	})
	path := filepath.Join(dir, "settings.json")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("save bypassed its predecessor: %v", err)
	}
	release.Do(func() { close(gate) })
	configWrites.Wait()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"quietStartup": true, "retry": map[string]any{"enabled": true}, "compaction": map[string]any{"keepRecentTokens": float64(2048)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("queued saves lost or reordered edits: %s", raw)
	}
}
