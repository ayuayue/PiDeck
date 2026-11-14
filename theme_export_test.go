package main

// Checks the theme picker's miniature and the exported theme file.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/nsgotest"
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
