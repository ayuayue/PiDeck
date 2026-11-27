//go:build !js && !android && !ios

package workbench

// Checks the rail's look button: it flips the current palette to its other
// side and keeps it, instead of stepping every theme to the system default.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// lookFixture starts the app on one look with the system in light, and pins
// the side the config carries when side is not empty.
func lookFixture(t *testing.T, theme, side string) (*app, *nsgotest.App, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	t.Cleanup(configWrites.Wait)
	cfg := config{Version: configVersion, Theme: theme, Appearance: side,
		ScanPi: false, AutoModelCatalog: false, SidebarOpen: true}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800),
		nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop, Dark: false}))
	if built == nil {
		t.Fatal("the app was not built")
	}
	t.Cleanup(sessionDraftWrites.Wait)
	t.Cleanup(built.closeDiag)
	return built, screen, home
}

// TestLookButtonKeepsPalette flips 羊皮纸's light side to its dark side and
// back, keeping the theme and its colors the whole way.
func TestLookButtonKeepsPalette(t *testing.T) {
	built, screen, home := lookFixture(t, "parchment", "light")
	// Themes read a moment after the window mounts; until they land the
	// app shows the foundation's palette.
	screen.WaitUntil(10*time.Second, func() bool { return built.themeSpec("parchment") != nil })
	theme := built.themeSpec("parchment")
	if theme == nil {
		t.Fatal("the parchment theme is missing")
	}
	light, err := core.ParseColor(theme.Light["background"])
	if err != nil {
		t.Fatalf("羊皮纸 light background: %v", err)
	}
	dark, err := core.ParseColor(theme.Dark["background"])
	if err != nil {
		t.Fatalf("羊皮纸 dark background: %v", err)
	}
	assertSide := func(want string) {
		t.Helper()
		background := light
		if want == "dark" {
			background = dark
		}
		if got := built.theme.Get(); got != "parchment" {
			t.Errorf("theme = %q, want parchment: the button took another theme", got)
		}
		if got := built.cfg.Appearance; got != want {
			t.Errorf("pinned side = %q, want %q", got, want)
		}
		if got := built.cx.Dark(); got != (want == "dark") {
			t.Errorf("dark = %v, want %v", got, want == "dark")
		}
		palette := built.cx.Palette()
		if got, ok := palette.Color("background"); !ok || got != background {
			t.Errorf("background = %v, want 羊皮纸's %s side %v", got, want, background)
		}
	}

	assertSide("light")
	screen.Press("label:切换外观")
	assertSide("dark")
	configWrites.Wait()
	raw, err := os.ReadFile(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"theme": "parchment"`) || !strings.Contains(string(raw), `"appearance": "dark"`) {
		t.Fatalf("config.json = %s, want 羊皮纸 pinned dark", raw)
	}
	screen.Press("label:切换外观")
	assertSide("light")
}

// TestLookButtonSwapsFoundationHalves checks the two foundation looks, whose
// sides are their ids, swap 纸白 and 炭黑.
func TestLookButtonSwapsFoundationHalves(t *testing.T) {
	built, screen, _ := lookFixture(t, "light", "")
	screen.WaitFor("label:切换外观", 10*time.Second)
	screen.Press("label:切换外观")
	if got := built.theme.Get(); got != "dark" {
		t.Errorf("theme = %q, want dark", got)
	}
	if got := built.cfg.Appearance; got != "" {
		t.Errorf("pinned side = %q, want none", got)
	}
	if !built.cx.Dark() {
		t.Error("炭黑 did not show its dark side")
	}
	screen.Press("label:切换外观")
	if got := built.theme.Get(); got != "light" {
		t.Errorf("theme = %q, want light", got)
	}
	if built.cx.Dark() {
		t.Error("纸白 did not show its light side")
	}
}

// TestAppearanceConfigNormalized keeps the sides the app understands and
// drops what a hand-edited config or a theme file could carry instead.
func TestAppearanceConfigNormalized(t *testing.T) {
	for _, tc := range []struct {
		name, in, want string
	}{
		{"none", "", ""},
		{"light", "light", "light"},
		{"dark", "dark", "dark"},
		{"spaced and cased", " Dark ", "dark"},
		{"a theme's both", "both", ""},
		{"a typo", "lights", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := config{Version: configVersion, Theme: "parchment", Appearance: tc.in}
			if changed := migrateConfig(&c, nil); tc.in != tc.want && !changed {
				t.Error("normalizing the side did not report a change")
			}
			if c.Appearance != tc.want {
				t.Errorf("appearance = %q, want %q", c.Appearance, tc.want)
			}
		})
	}
}

// TestPickingThemeDropsPinnedSide checks a palette theme follows the system
// until the button pins a side, and that picking a theme starts it over.
func TestPickingThemeDropsPinnedSide(t *testing.T) {
	built, screen, _ := lookFixture(t, "parchment", "")
	screen.WaitUntil(10*time.Second, func() bool { return built.themeSpec("parchment") != nil })
	if built.cx.Dark() {
		t.Error("羊皮纸 did not follow the light system")
	}
	screen.Press("label:切换外观")
	if !built.cx.Dark() {
		t.Error("the button did not pin 羊皮纸's dark side")
	}
	screen.Post(func() { built.setTheme("fresh-green") })
	screen.Settle()
	if got := built.cfg.Appearance; got != "" {
		t.Errorf("pinned side after picking a theme = %q, want none", got)
	}
	if got := built.theme.Get(); got != "fresh-green" {
		t.Errorf("theme = %q, want fresh-green", got)
	}
	if built.cx.Dark() {
		t.Error("森系绿 did not start on the light system's side")
	}
}

func TestAppearanceConfigMigration(t *testing.T) {
	for _, theme := range []string{"system", "light", "dark", "parchment"} {
		t.Run(theme, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "config.json")
			raw, err := json.Marshal(config{Version: 5, Theme: theme})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, raw, 0o600); err != nil {
				t.Fatal(err)
			}
			st, err := newStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			got := st.config()
			if got.Version != configVersion || got.Theme != theme || got.Appearance != "" {
				t.Fatalf("migrated version/theme/side = %d/%q/%q", got.Version, got.Theme, got.Appearance)
			}
			raw, err = os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var saved config
			if err := json.Unmarshal(raw, &saved); err != nil {
				t.Fatal(err)
			}
			if saved.Version != configVersion || saved.Theme != theme || saved.Appearance != "" {
				t.Fatalf("persisted version/theme/side = %d/%q/%q", saved.Version, saved.Theme, saved.Appearance)
			}
		})
	}
}

func TestAppearanceCommandCompatibility(t *testing.T) {
	built, screen, _ := lookFixture(t, "light", "")
	screen.Post(func() { built.runCommand("appearance") })
	screen.Settle()
	if !built.cx.Dark() || built.theme.GetUntracked() != "dark" {
		t.Fatal("the legacy appearance command did not switch to dark")
	}
}

func TestAppearanceSettingSchema(t *testing.T) {
	for _, field := range appSettingFields {
		if field.Key != "appearance" {
			continue
		}
		if field.Type != "enum" || field.Default != "" || strings.Join(field.Values, "|") != "|light|dark" {
			t.Fatalf("appearance schema = %+v", field)
		}
		return
	}
	t.Fatal("appearance is missing from the settings schema")
}
