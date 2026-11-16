package main

// Checks the theme picker's miniature and the exported theme file.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestThemePreviewColors(t *testing.T) {
	light := themeSpec{ID: "light"}
	dark := themeSpec{ID: "dark"}
	if light.previewColor("background") == dark.previewColor("background") {
		t.Fatal("light and dark previews look the same")
	}
	red := themeSpec{ID: "user:red", Light: map[string]string{"accent": "#ff0000"}}
	r, g, b, _ := red.previewColor("accent").Components()
	if r < 0.99 || g > 0.01 || b > 0.01 {
		t.Fatalf("accent = %v %v %v", r, g, b)
	}
	if red.previewColor("background") == core.Transparent {
		t.Fatal("background did not fall back to the app's palette")
	}
}

func TestExportTheme(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-look")
	app.WaitFor("id:theme-export", 5*time.Second)
	app.Press("id:theme-export")
	dir := filepath.Join(home, "themes")
	deadline := time.Now().Add(5 * time.Second)
	var path string
	for {
		entries, err := os.ReadDir(dir)
		if err == nil {
			for _, e := range entries {
				if filepath.Ext(e.Name()) == ".json" {
					path = filepath.Join(dir, e.Name())
				}
			}
		}
		if path != "" || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if path == "" {
		t.Fatal("no theme file was written")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f themeFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if f.Name == "" || f.Light["background"] == "" || f.Dark["text"] == "" {
		t.Fatalf("theme file = %+v", f)
	}
}

// TestCycleAppearance walks system, light and dark with the shortcut.
func TestCycleAppearance(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	read := func() string {
		raw, err := os.ReadFile(filepath.Join(home, "config.json"))
		if err != nil {
			return ""
		}
		var c config
		_ = json.Unmarshal(raw, &c)
		return c.Theme
	}
	app.Key("mod+shift+l")
	app.WaitUntil(5*time.Second, func() bool { return read() == "light" })
	app.Key("mod+shift+l")
	app.WaitUntil(5*time.Second, func() bool { return read() == "dark" })
	app.Key("mod+shift+l")
	app.WaitUntil(5*time.Second, func() bool { return read() == "system" })
}

// TestTerminalFont keeps the terminal's text size.
func TestTerminalFont(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-look")
	app.WaitFor("id:term-font", 5*time.Second)
	app.Drag("id:term-font-thumb", core.Point{X: 20})
	app.WaitUntil(5*time.Second, func() bool {
		raw, err := os.ReadFile(filepath.Join(home, "config.json"))
		if err != nil {
			return false
		}
		var c config
		return json.Unmarshal(raw, &c) == nil && c.TerminalFont > 12.5 && c.TerminalFont <= 20
	})
}

// TestTerminalFontNormalized drops out-of-range sizes.
func TestTerminalFontNormalized(t *testing.T) {
	for _, size := range []float64{5, 25} {
		c := &config{TerminalFont: size}
		if !normalizeConfig(c) || c.TerminalFont != 0 {
			t.Fatalf("%v normalized to %v", size, c.TerminalFont)
		}
	}
	c := &config{TerminalFont: 14}
	if normalizeConfig(c) || c.TerminalFont != 14 {
		t.Fatalf("14 normalized to %v", c.TerminalFont)
	}
}

// TestDeleteTheme removes a user theme file from the look page.
func TestDeleteTheme(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	dir := filepath.Join(home, "themes")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "team.json")
	if err := os.WriteFile(path, []byte(`{"id":"team","name":"团队主题","light":{"accent":"#ff0000"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-look")
	app.WaitFor("id:theme-delete-user-team", 10*time.Second)
	app.Press("id:theme-delete-user-team")
	app.WaitFor("id:confirm-ok", 5*time.Second)
	app.Press("id:confirm-ok")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the theme file was not removed")
		}
		time.Sleep(50 * time.Millisecond)
	}
	app.WaitForGone("id:theme-delete-user-team", 10*time.Second)
}

// TestPiDeckThemes checks every palette PiDeck ships has both sides.
func TestPiDeckThemes(t *testing.T) {
	want := []string{"system", "fresh-green", "graphite", "sea-blue", "parchment", "tui"}
	byID := map[string]themeSpec{}
	for _, s := range builtinThemes() {
		byID[s.ID] = s
	}
	for _, id := range want {
		s, ok := byID[id]
		if !ok {
			t.Errorf("missing theme %q", id)
			continue
		}
		if id != "system" && (s.Light["background"] == "" || s.Dark["background"] == "") {
			t.Errorf("theme %q has no light or dark background", id)
		}
	}
}
