//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

// Mount only the dialogs under test, without a sidebar or uninitialized projects.
func desktopDialogFixture(t *testing.T) (*app, *nsgotest.App) {
	t.Helper()
	fakeProviders(t)
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"scanPi":false,"telemetryEnabled":false,"autoModelCatalog":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		cx.SetTheme(viewkit.Theme())
		built = newApp(cx)
		return core.View{Style: ui.FillRest, Children: []core.Node{built.projectRemoveDialog(), built.acpPresetManagerDialog()}}
	}, nsgotest.Size(1280, 860), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	t.Cleanup(built.closeDiag)
	return built, screen
}

func dialogInside(t *testing.T, screen *nsgotest.App, selector string, width, height core.Points) core.Bounds {
	t.Helper()
	b := screen.Find(selector).Bounds()
	if b.Size.Width <= 0 || b.Size.Height <= 0 || b.Origin.X < 0 || b.Origin.Y < 0 ||
		b.Origin.X+b.Size.Width > width+1 || b.Origin.Y+b.Size.Height > height+1 {
		t.Fatalf("%s is outside %gx%g: %+v", selector, width, height, b)
	}
	return b
}

func TestProjectRemoveDialogFitsContents(t *testing.T) {
	built, screen := desktopDialogFixture(t)
	projects := func(count int) {
		items := make([]*workspace, count)
		for i := range items {
			items[i] = &workspace{Path: fmt.Sprintf("/projects/project-%d", i), Name: fmt.Sprintf("Project %d", i)}
		}
		built.workspaces.Set(items)
	}
	projects(1)
	built.projectRemoveOpen.Set(true)
	screen.WaitFor("id:project-remove-dialog", 5*time.Second)
	small := screen.Find("id:project-remove-dialog").Bounds()
	if small.Size.Width > 560 || small.Size.Height > 260 {
		t.Fatalf("one project leaves an oversized dialog: %+v", small)
	}
	projects(24)
	screen.Settle()
	large := screen.Find("id:project-remove-dialog").Bounds()
	if large.Size.Height <= small.Size.Height || large.Size.Height > 440 {
		t.Fatalf("project list height did not grow within its limit: small=%+v large=%+v", small, large)
	}
	screen.Resize(640, 420)
	screen.Settle()
	dialogInside(t, screen, "id:project-remove-dialog", 640, 420)
	dialogInside(t, screen, "id:project-remove-submit", 640, 420)
	list := screen.Find("id:project-remove-list")
	screen.Scroll("id:project-remove-list", list.Content.Height)
	dialogInside(t, screen, "id:project-remove-submit", 640, 420)
}

func TestReplyShortcutDialogFitsShortWindow(t *testing.T) {
	screen, built, _ := replyShortcutFixture(t)
	built.openReplyShortcutSettings()
	screen.WaitFor("id:reply-shortcuts-dialog", 5*time.Second)
	b := screen.Find("id:reply-shortcuts-dialog").Bounds()
	if b.Size.Width > 640 || b.Size.Height > 464 {
		t.Fatalf("shortcut editor is oversized: %+v", b)
	}
	screen.Resize(600, 420)
	screen.Settle()
	for _, tab := range []string{"shortcut-tab-phrases", "shortcut-tab-rules"} {
		screen.Press("id:" + tab)
		dialogInside(t, screen, "id:reply-shortcuts-dialog", 600, 420)
		dialogInside(t, screen, "id:shortcut-save", 600, 420)
	}
}

func TestACPPresetDialogFitsShortWindow(t *testing.T) {
	built, screen := desktopDialogFixture(t)
	built.openACPPresetManager()
	screen.WaitFor("id:acp-preset-row-gemini", 5*time.Second)
	b := screen.Find("id:acp-preset-manager").Bounds()
	if b.Size.Width > 840 || b.Size.Height > 544 {
		t.Fatalf("preset manager is oversized: %+v", b)
	}
	for _, size := range []core.Size{{Width: 960, Height: 520}, {Width: 600, Height: 520}} {
		screen.Resize(size.Width, size.Height)
		screen.Settle()
		dialogInside(t, screen, "id:acp-preset-manager", size.Width, size.Height)
		button := dialogInside(t, screen, "id:acp-preset-save", size.Width, size.Height)
		editor := screen.Find("id:acp-preset-editor")
		if editor.Bounds().Size.Height <= 0 {
			t.Fatal("preset editor collapsed")
		}
		if editor.Content.Height > editor.Bounds().Size.Height+1 {
			screen.Scroll("id:acp-preset-editor", editor.Content.Height)
		}
		if got := screen.Find("id:acp-preset-save").Bounds(); got != button {
			t.Fatalf("scrolling moved the preset save button: before=%+v after=%+v", button, got)
		}
	}
}
