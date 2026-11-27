//go:build !js && !android && !ios

package workbench

// Checks the editor's text size setting: bounds, persistence and the
// config it writes.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestNormalizeEditorFont(t *testing.T) {
	c := config{Version: configVersion, EditorFont: 4, Titles: map[string]string{}}
	normalizeConfig(&c)
	if c.EditorFont != 0 {
		t.Fatalf("EditorFont = %d, want 0", c.EditorFont)
	}
	c = config{Version: configVersion, EditorFont: 18, Titles: map[string]string{}}
	normalizeConfig(&c)
	if c.EditorFont != 18 {
		t.Fatalf("EditorFont = %d, want 18", c.EditorFont)
	}
}

func TestEditorFontSetting(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Cleanup(configWrites.Wait)
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	if built == nil {
		t.Fatal("the app did not build")
	}

	onNativeUI(t, screen, built, func() {
		built.setEditorFont(16)
		if got := built.editorFont.GetUntracked(); got != 16 {
			t.Fatalf("editorFont = %v, want 16", got)
		}
	})
	read := func() string {
		raw, _ := os.ReadFile(filepath.Join(home, "config.json"))
		return string(raw)
	}
	configWrites.Wait()
	if !strings.Contains(read(), `"editorFont": 16`) {
		t.Fatalf("config = %s", read())
	}

	// The bounds hold, and the default is not stored.
	onNativeUI(t, screen, built, func() {
		built.setEditorFont(99)
		if got := built.editorFont.GetUntracked(); got != 20 {
			t.Fatalf("clamped = %v, want 20", got)
		}
		built.setEditorFont(13)
	})
	configWrites.Wait()
	if strings.Contains(read(), "editorFont") {
		t.Fatalf("default size was stored: %s", read())
	}
}

// TestEditorFontSettingsRow finds the slider in 设置 → 外观.
func TestEditorFontSettingsRow(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := startApp(t, dir, 1280, 860)
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-look", 5*time.Second)
	app.Press("id:settings-tab-look")
	app.WaitFor("id:editor-font", 10*time.Second)
	app.WaitFor("text:编辑器字号", 10*time.Second)
}
