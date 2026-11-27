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
	t.Setenv("PIDECK_V2_HOME", home)
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
	if testing.Short() {
		t.Skip("continuous drag coverage")
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.setBackgroundImage("wallpaper.png")
		built.openSettingsPane()
		built.openSettingsSection("look")
	})
	revealLookControl(screen, "bg-opacity")
	var before, after float64
	onNativeUI(t, screen, built, func() { before = built.backgroundOpacity() })
	screen.Drag("id:bg-opacity-thumb", core.Point{X: -20}, core.Point{X: -40}, core.Point{X: -60})
	onNativeUI(t, screen, built, func() { after = built.backgroundOpacity() })
	if after >= before-0.25 {
		t.Fatalf("the drag moved opacity %v -> %v: it stopped under the finger", before, after)
	}
}
