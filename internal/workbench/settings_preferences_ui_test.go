//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func settingsPreferencesFixture(t *testing.T, width, height core.Points, dark bool) (*nsgotest.App, *app) {
	t.Helper()
	home := t.TempDir()
	t.Cleanup(configWrites.Wait)
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		cx.SetTheme(viewkit.Theme())
		if dark {
			cx.SetAppearance(core.AppearanceDark)
		} else {
			cx.SetAppearance(core.AppearanceLight)
		}
		cfg := config{Language: "zh-CN", Thinking: "high"}
		built = &app{
			cx: cx, cfg: cfg, defaultThinking: cfg.Thinking,
			st:          &store{dir: home, path: filepath.Join(home, "config.json"), c: &cfg},
			settingsTab: core.NewSignal(cx, "general"), settingsQuery: core.NewSignal(cx, ""),
			settingsRev: core.NewSignal(cx, 0), langRev: core.NewSignal(cx, 0),
			chatWidthPctSig: core.NewSignal(cx, chatWidthPctDefault),
			tabWidthPctSig:  core.NewSignal(cx, tabWidthPctDefault),
			favModels:       core.NewSignalFunc(cx, []string{}, nil),
			themes:          core.NewSignalFunc(cx, builtinThemes()[:3], nil), theme: core.NewSignal(cx, "system"),
			codeWrap: core.NewSignal(cx, false), reduceEffects: core.NewSignal(cx, false),
			chatFont: core.NewSignal(cx, float64(viewkit.ChatFontDefault)),
			chatLine: core.NewSignal(cx, float64(viewkit.ChatLineDefault)), inputFont: core.NewSignal(cx, float64(0)),
			termFont: core.NewSignal(cx, float64(11)), editorFont: core.NewSignal(cx, float64(13)),
			footerMetrics: core.NewSignal(cx, ""), uiFont: core.NewSignal(cx, ""), monoFont: core.NewSignal(cx, ""),
			brandRev: core.NewSignal(cx, 0), brandNameRev: core.NewSignal(cx, 0), brandInputRev: core.NewSignal(cx, 0),
			brandBusy: core.NewSignal(cx, false), brandError: core.NewSignal(cx, ""),
			bgImage: core.NewSignal(cx, ""), bgOpacity: core.NewSignal(cx, float64(0.1)),
		}
		return core.View{Style: ui.FillRest.Merge(core.Style{FontFamily: cx.Theme().Sans}), Children: []core.Node{built.settingsPane()}}
	}, nsgotest.Size(width, height), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	screen.WaitFor("id:settings-page", 5*time.Second)
	return screen, built
}

func TestSettingsThinkingSelectionRefreshes(t *testing.T) {
	screen, built := settingsPreferencesFixture(t, 960, 640, false)
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-general-before-selection")
	}
	high := screen.Find("role:radio 高").Style.BorderColor
	off := screen.Find("role:radio 关").Style.BorderColor
	if high == off {
		t.Fatal("selected and unselected thinking levels are not distinguishable")
	}
	screen.Press("role:radio 关")
	if built.defaultThinking != "off" || built.st.config().Thinking != "off" {
		t.Fatal("thinking selection did not update the new-session default")
	}
	screen.WaitUntil(5*time.Second, func() bool {
		return screen.Find("role:radio 关").Style.BorderColor == high && screen.Find("role:radio 高").Style.BorderColor == off
	})
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-general-selected")
	}
	configWrites.Wait()
	raw, err := os.ReadFile(built.st.path)
	if err != nil {
		t.Fatal(err)
	}
	var saved config
	if err := json.Unmarshal(raw, &saved); err != nil || saved.Thinking != "off" {
		t.Fatalf("persisted thinking level = %q, decode error = %v", saved.Thinking, err)
	}
	screen.Press("role:radio 使用 pi 默认值")
	if built.defaultThinking != "" || built.st.config().Thinking != "" {
		t.Fatal("using pi default did not clear the thinking override")
	}
}

func TestSettingsPreferencesNavigation(t *testing.T) {
	want := []string{"general", "look", "keys", "models", "credentials", "pi", "env", "mcp", "resources", "addons", "integrations", "remote", "usage", "data", "diagnostics", "about"}
	if len(settingsSections()) != len(want) {
		t.Fatalf("settings section count = %d, want %d", len(settingsSections()), len(want))
	}
	for i, section := range settingsSections() {
		if i >= len(want) || section.ID != want[i] {
			t.Fatalf("settings navigation at %d = %s, want %v", i, section.ID, want)
		}
	}
	for query, section := range map[string]string{"模型与认证": "models", "资源": "resources", "thinking": "general"} {
		found := false
		for _, hit := range searchSettings(query) {
			found = found || hit.Section == section
		}
		if !found {
			t.Errorf("settings query %q no longer reaches %s", query, section)
		}
	}
	for _, dark := range []bool{false, true} {
		name := "light"
		if dark {
			name = "dark"
		}
		t.Run(name, func(t *testing.T) {
			screen, built := settingsPreferencesFixture(t, 960, 640, dark)
			for _, id := range want[:3] {
				screen.Find("id:settings-tab-" + id)
			}
			screen.Press("id:settings-tab-look")
			screen.WaitFor("id:theme-system", 5*time.Second)
			if built.settingsTab.GetUntracked() != "look" {
				t.Fatal("appearance tab did not open")
			}
			if nsgotest.Target() != "" {
				screen.Screenshot("settings-look-" + name)
			}
			page := screen.Find("id:settings-page").Bounds()
			font := screen.QueryMounted("id:ui-font")[0].Bounds()
			screen.Scroll("id:settings-page", font.Origin.Y-page.Origin.Y-30)
			screen.WaitFor("id:ui-font", 5*time.Second)
			control := screen.Find("id:ui-font").Bounds()
			if control.Origin.X < page.Origin.X || control.Origin.X+control.Size.Width > page.Origin.X+page.Size.Width {
				t.Fatalf("font control overflows its page: page=%+v control=%+v", page, control)
			}
			if nsgotest.Target() != "" {
				screen.Screenshot("settings-look-fonts-" + name)
			}
			screen.Scroll("id:settings-navigation", 2000)
			screen.WaitFor("id:settings-tab-about", 5*time.Second)
			screen.Find("id:settings-done")
		})
	}
}

func TestSettingsHelpRemainsReadable(t *testing.T) {
	help := strings.Repeat("整个界面的字体（代码与等宽处除外）；系统已安装的字体名，如 Georgia。留空跟随主题，回车、失焦或点「应用」生效。", 3)
	for _, tt := range []struct {
		name  string
		width core.Points
		dark  bool
	}{
		{name: "regular", width: 760},
		{name: "compact-dark", width: 420, dark: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				cx.SetTheme(viewkit.Theme())
				if tt.dark {
					cx.SetAppearance(core.AppearanceDark)
				}
				return core.View{Style: ui.FillRest.Merge(core.Style{FontFamily: cx.Theme().Sans, Padding: core.All(20)}),
					StyleFunc: ui.Filled(ui.ColorsOf(cx).Background), Children: []core.Node{
						setGroup("字体", setRow("界面字体", help, core.Input{
							Label: "界面字体", TestID: "settings-test-font", Placeholder: "Georgia",
							Style: core.Style{Width: core.Pt(230), Height: core.Pt(28)},
						})),
					}}
			}, nsgotest.Size(tt.width, 360))
			if nsgotest.Target() != "" {
				screen.Screenshot("settings-help-" + tt.name)
			}
			text := screen.Find("text:" + help)
			if tt.width < 600 && text.Bounds().Size.Height <= 32 {
				t.Fatalf("help remains limited to two lines: bounds=%+v", text.Bounds())
			}
			if text.Bounds().Size.Width < 240 {
				t.Fatalf("help is squeezed beside its control: bounds=%+v", text.Bounds())
			}
			control := screen.Find("id:settings-test-font").Bounds()
			if control.Origin.X < 0 || control.Origin.X+control.Size.Width > tt.width {
				t.Fatalf("control overflows the settings row: bounds=%+v", control)
			}
		})
	}
}
