//go:build !js && !android && !ios

package workbench

// Checks the picture behind the app and its opacity.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestBackgroundImageAndOpacity(t *testing.T) {
	home, workspace := editorWorkspace(t), editorWorkspace(t)
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, _ := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "BgProject"}},
		Theme: "system", SidebarOpen: true})
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	screen.Advance(100 * time.Millisecond)

	built.setBackgroundImage("/tmp/pideck-background.png")
	if built.bgImage.GetUntracked() == "" || built.cfg.BackgroundImage == "" {
		t.Fatal("the image was not stored")
	}
	if math.Abs(built.backgroundOpacity()-0.8) > 0.001 {
		t.Fatalf("default opacity = %v", built.backgroundOpacity())
	}
	built.setBackgroundOpacity(0.35)
	if math.Abs(built.backgroundOpacity()-0.35) > 0.001 {
		t.Fatalf("opacity = %v", built.backgroundOpacity())
	}
	// The panels keep one alpha and the veil alone follows the slider, which
	// is what keeps a drag live: nothing about the theme changes.
	if _, _, _, a := built.cx.Palette().Background.Components(); math.Abs(float64(a)-0.3) > 0.01 {
		t.Fatalf("background alpha = %v, want the wallpaper's 0.3", a)
	}

	built.setBackgroundImage("")
	if built.cfg.BackgroundImage != "" || built.cfg.BackgroundOpacity != nil || built.bgImage.GetUntracked() != "" {
		t.Fatalf("cleared background = %+v", built.cfg)
	}
	if _, _, _, a := built.cx.Palette().Background.Components(); a < 0.99 {
		t.Fatalf("background stayed translucent: alpha %v", a)
	}
}

// TestBackgroundOpacityDrag drags the opacity slider and checks the value
// follows the whole drag: a page rebuilt under the finger would drop it.
func TestBackgroundOpacityDrag(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	app := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	app.Press("label:设置")
	app.Press("id:settings-tab-look")
	app.WaitFor("id:bg-opacity-thumb", 5*time.Second)
	before := built.backgroundOpacity()
	app.Drag("id:bg-opacity-thumb", core.Point{X: -40}, core.Point{X: -80}, core.Point{X: -120})
	after := built.backgroundOpacity()
	if after >= before-0.1 {
		t.Fatalf("the drag moved opacity %v -> %v: it stopped under the finger", before, after)
	}
}
