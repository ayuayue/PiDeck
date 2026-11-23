//go:build !js && !android && !ios

package workbench

// Checks the Git drawer's own toolbars: the sync buttons say what they do
// when the pointer rests on them, and the "more" menu opens under its
// button instead of at the window's corner.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// startGitDesktop opens the app on a repository with the desktop idiom:
// hover hints exist nowhere else.
func startGitDesktop(t *testing.T, dir string) *nsgotest.App {
	t.Helper()
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	cfg, err := json.Marshal(config{Version: 2, Workspaces: []workspaceCfg{{Path: dir, Expanded: true}},
		Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860), nsgotest.Idiom(core.IdiomDesktop))
	app.Press("id:git-toggle")
	waitApp(app, "id:git-more", 20*time.Second)
	return app
}

func TestGitHeaderHints(t *testing.T) {
	dir, _ := gitFixture(t)
	app := startGitDesktop(t, dir)
	for _, want := range []struct{ selector, hint string }{
		{"id:git-fetch", "获取远程（fetch）"},
		{"id:git-pull", "拉取（pull）"},
		{"id:git-push", "推送（push）"},
		{"id:git-refresh", "刷新 Git"},
	} {
		app.Hover(want.selector)
		app.Advance(time.Second)
		if !app.Exists("text:" + want.hint) {
			t.Fatalf("%s shows no hint %q", want.selector, want.hint)
		}
		app.HoverOut()
		app.Advance(time.Second)
		if app.Exists("text:" + want.hint) {
			t.Fatalf("%s kept its hint after the pointer left", want.selector)
		}
	}
}

func TestGitMoreMenuAnchorsToItsButton(t *testing.T) {
	dir, _ := gitFixture(t)
	app := startGitDesktop(t, dir)
	button := app.Find("id:git-more")
	if button == nil {
		t.Fatal("the drawer has no more button")
	}
	app.Press("id:git-more")
	app.WaitFor("role:menuitem 远端…", 5*time.Second)
	item := app.Find("role:menuitem 远端…")
	if item.Frame.Origin.Y < button.Frame.Origin.Y {
		t.Fatalf("the menu opened at y=%v, above its button at y=%v",
			item.Frame.Origin.Y, button.Frame.Origin.Y)
	}
	if item.Frame.Origin.X <= 0 && button.Frame.Origin.X > 0 {
		t.Fatalf("the menu opened at x=%v, away from its button at x=%v",
			item.Frame.Origin.X, button.Frame.Origin.X)
	}
}
