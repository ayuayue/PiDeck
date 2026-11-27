//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestLookOpacityUpdatesExitSnapshot(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(configWrites.Wait)
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = &app{cx: cx, st: st, cfg: st.config(), bgOpacity: core.NewSignal(cx, 0.8)}
		return core.View{}
	})
	onNativeUI(t, screen, built, func() { built.setBackgroundOpacity(0.37) })
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(st.path)
	if err != nil {
		t.Fatal(err)
	}
	var saved config
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.BackgroundOpacity == nil || *saved.BackgroundOpacity != 0.37 {
		t.Fatalf("exit lost the latest wallpaper visibility: %v", saved.BackgroundOpacity)
	}
}

func TestLookClearingWallpaperCancelsPendingOpacity(t *testing.T) {
	screen, built := settingsPreferencesFixture(t, 1200, 800, false)
	onNativeUI(t, screen, built, func() {
		built.setBackgroundImage("wallpaper.png")
		built.setBackgroundOpacity(0.37)
		built.setBackgroundImage("")
	})
	screen.Advance(350 * time.Millisecond)
	onNativeUI(t, screen, built, func() {
		if got := built.st.config().BackgroundOpacity; got != nil {
			t.Fatalf("a stale slider write restored cleared wallpaper settings: %v", *got)
		}
	})
}

func TestLookWallpaperVisibilityDependency(t *testing.T) {
	screen, built := settingsPreferencesFixture(t, 1200, 800, false)
	onNativeUI(t, screen, built, func() { built.openSettingsSection("look") })
	screen.WaitFor("id:theme-system", 5*time.Second)
	if !screen.FindMounted("id:bg-opacity").Props.Disabled {
		t.Fatal("wallpaper visibility is active without a wallpaper")
	}
}

// revealLookControl uses native scrolling as well as the headless host.
func revealLookControl(screen *nsgotest.App, id string) {
	page := screen.Find("id:settings-page").Bounds()
	control := screen.FindMounted("id:" + id).Bounds()
	if control.Origin.Y < page.Origin.Y || control.Origin.Y+control.Size.Height > page.Origin.Y+page.Size.Height {
		screen.Scroll("id:settings-page", control.Origin.Y-page.Origin.Y-30)
	}
	screen.WaitFor("id:"+id, 5*time.Second)
}

func TestLookThemeModeSelection(t *testing.T) {
	screen, built := settingsPreferencesFixture(t, 1200, 800, false)
	onNativeUI(t, screen, built, func() {
		built.themes.Set(append(builtinThemes(), themeSpec{ID: "fixed-dark", Name: "Fixed dark", Appearance: "dark"}))
		built.openSettingsSection("look")
	})
	screen.Press("id:look-appearance")
	screen.Press("id:look-appearance-2")
	screen.Press("id:theme-parchment")
	onNativeUI(t, screen, built, func() {
		if built.cfg.Appearance != "dark" || built.cfg.Theme != "parchment" || !built.cx.Dark() {
			t.Fatalf("picking a palette lost the explicit mode: %s/%s dark=%v", built.cfg.Theme, built.cfg.Appearance, built.cx.Dark())
		}
	})
	screen.Press("id:look-appearance")
	screen.Press("id:look-appearance-0")
	onNativeUI(t, screen, built, func() {
		if built.cfg.Appearance != "" || built.cx.Dark() {
			t.Fatal("follow system did not clear the dark override")
		}
	})
	screen.Press("id:theme-fixed-dark")
	if !screen.FindMounted("id:look-appearance").Props.Disabled {
		t.Fatal("a single-side theme exposes an ineffective mode selector")
	}
	configWrites.Wait()
	if got := built.st.config(); got.Theme != "fixed-dark" || got.Appearance != "" {
		t.Fatalf("theme/mode was not kept: %q/%q", got.Theme, got.Appearance)
	}
}

func TestLookFontDraftCommitsOnSubmit(t *testing.T) {
	screen, built := settingsPreferencesFixture(t, 1200, 800, false)
	onNativeUI(t, screen, built, func() { built.openSettingsSection("look") })
	revealLookControl(screen, "ui-font")
	before := screen.Find("id:ui-font").ID
	screen.Type("id:ui-font", " Georgia ")
	onNativeUI(t, screen, built, func() {
		if built.cfg.UIFont != "" || built.st.config().UIFont != "" {
			t.Fatal("an unfinished font draft was saved")
		}
	})
	if screen.Find("id:ui-font").ID != before {
		t.Fatal("typing rebuilt the focused font field")
	}
	screen.Key("enter")
	onNativeUI(t, screen, built, func() {
		if built.cfg.UIFont != "Georgia" || built.st.config().UIFont != "Georgia" {
			t.Fatal("submitting the font did not trim and commit it")
		}
	})
	revealLookControl(screen, "mono-font")
	screen.Type("id:mono-font", "Consolas")
	screen.Press("id:ui-font") // Blurring also commits a font draft.
	onNativeUI(t, screen, built, func() {
		if built.cfg.MonoFont != "Consolas" || built.st.config().MonoFont != "Consolas" {
			t.Fatal("leaving the font field did not commit it")
		}
	})
	configWrites.Wait()
	raw, err := os.ReadFile(built.st.path)
	if err != nil {
		t.Fatal(err)
	}
	var saved config
	if err := json.Unmarshal(raw, &saved); err != nil || saved.UIFont != "Georgia" || saved.MonoFont != "Consolas" {
		t.Fatalf("saved fonts: %q/%q, error=%v", saved.UIFont, saved.MonoFont, err)
	}
}

func TestLookTypographyReset(t *testing.T) {
	screen, built := settingsPreferencesFixture(t, 1200, 800, false)
	onNativeUI(t, screen, built, func() {
		built.openSettingsSection("look")
		built.setChatFont(20)
		built.setChatLine(2)
		built.setInputFont(18)
		built.setTerminalFont(16)
		built.setEditorFont(19)
		built.cfg.UIFont = "Georgia"
		built.st.change(func(c *config) { c.UIFont = "Georgia" })
	})
	revealLookControl(screen, "look-typography-reset")
	screen.Press("id:look-typography-reset")
	onNativeUI(t, screen, built, func() {
		if built.chatFont.Get() != 16 || built.chatLine.Get() != 1.6 || built.inputFont.Get() != 0 || built.termFont.Get() != 12.5 || built.editorFont.Get() != 13 {
			t.Fatal("reset did not restore every typography default")
		}
	})
	if got := built.st.config(); got.ChatFont != 0 || got.ChatLine != 0 || got.InputFont != 0 || got.TerminalFont != 0 || got.EditorFont != 0 || got.UIFont != "Georgia" {
		t.Fatalf("reset changed the wrong settings: %+v", got)
	}
}

func TestLookControlsAlign(t *testing.T) {
	screen, built := settingsPreferencesFixture(t, 1200, 800, false)
	onNativeUI(t, screen, built, func() {
		built.themes.Set(builtinThemes())
		built.openSettingsSection("look")
	})
	for _, width := range []core.Points{1200, 900} {
		screen.Resize(width, 800)
		editor := screen.FindMounted("id:editor-font").Bounds()
		for _, id := range []string{"term-font", "bg-opacity"} {
			control := screen.FindMounted("id:" + id).Bounds()
			if control.Origin.X != editor.Origin.X || control.Size.Width != editor.Size.Width {
				t.Fatalf("%s is misaligned at %g: editor=%+v control=%+v", id, width, editor, control)
			}
		}
		var palettes, metrics []string
		for _, spec := range builtinThemes() {
			if spec.ID != "light" && spec.ID != "dark" {
				palettes = append(palettes, "theme-"+spec.ID)
			}
		}
		for _, metric := range composerMetrics {
			metrics = append(metrics, "footer-metric-"+metric.ID)
		}
		for _, ids := range [][]string{palettes, metrics} {
			first := screen.FindMounted("id:" + ids[0]).Bounds()
			var columns []core.Points
			for _, id := range ids {
				bounds := screen.FindMounted("id:" + id).Bounds()
				if bounds.Origin.Y == first.Origin.Y {
					columns = append(columns, bounds.Origin.X)
					continue
				}
				aligned := false
				for _, x := range columns {
					aligned = aligned || bounds.Origin.X == x
				}
				if !aligned {
					t.Fatalf("%s shifted off its grid at %g: x=%g columns=%v", id, width, bounds.Origin.X, columns)
				}
			}
		}
		page := screen.Find("id:settings-page").Bounds()
		for _, id := range []string{"look-appearance", "ui-font", "mono-font", "brand-display-name"} {
			bounds := screen.FindMounted("id:" + id).Bounds()
			if bounds.Origin.X+bounds.Size.Width > page.Origin.X+page.Size.Width-scrollbarGutter {
				t.Fatalf("%s touches the scrollbar gutter at %g: page=%+v control=%+v", id, width, page, bounds)
			}
		}
	}
}

func TestLookSettingsScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() { built.openSettingsPane(); built.openSettingsSection("look") })
	screen.Resize(1200, 850)
	screen.WaitFor("id:theme-parchment", 5*time.Second)
	shot(screen, "look-redesign/top-light")
	revealLookControl(screen, "editor-font")
	shot(screen, "look-redesign/typography-fonts-light")
	revealLookControl(screen, "footer-metric-turns")
	shot(screen, "look-redesign/metrics-wallpaper-light")
	revealLookControl(screen, "brand-display-name")
	shot(screen, "look-redesign/brand-files-light")
	onNativeUI(t, screen, built, func() { built.setLook("parchment", "dark"); built.bumpSettings(); built.forgetScrolls("settings") })
	screen.Resize(900, 720)
	shot(screen, "look-redesign/top-narrow-dark")
	revealLookControl(screen, "ui-font")
	shot(screen, "look-redesign/fonts-narrow-dark")
}
