//go:build !js && !android && !ios

package workbench

// Checks that the terminal panel starts a real shell and shows its grid.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	sgt "github.com/nsgo-dev/nsgo/base/terminal"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestTerminalPanel opens the panel and waits for the terminal's view.
func TestTerminalPanel(t *testing.T) {
	if err := sgt.Load(); err != nil {
		t.Skipf("terminal unavailable: %v", err)
	}
	// The shell runs in the project, not the test's data directory: a
	// real shell holds its working directory open, which would keep the
	// temporary folder from being removed on Windows.
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: dir, Expanded: true}},
		Theme: "system", SidebarOpen: true, ScanPi: false, AutoModelCatalog: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(closeAllTerminals)
	var built *app
	options := []nsgotest.Option{nsgotest.Size(1320, 860)}
	if nsgotest.Target() == "" {
		options = append(options, nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	}
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, options...)
	t.Cleanup(built.closeDiag)
	app.Press("id:terminal-toggle")
	waitApp(app, "id:terminal-view", 30*time.Second)
	app.Advance(500 * time.Millisecond)
	shot(app, "comparison/terminal")
	app.RightClick("id:terminal-view")
	app.WaitFor("text:重启终端", 5*time.Second)
	shot(app, "comparison/terminal-view-menu")
	app.Key("escape")
	app.Press("label:搜索终端")
	app.WaitFor("id:terminal-search", 5*time.Second)
	app.Type("id:terminal-search", "pideck-audit-query")
	app.Advance(200 * time.Millisecond)
	shot(app, "comparison/terminal-search")
	app.Press("label:结束搜索")
	app.WaitForGone("id:terminal-search", 5*time.Second)
	// A second tab, then hiding the panel keeps both running.
	if runtime.GOOS == "windows" {
		app.WaitFor("id:terminal-shell-picker", 15*time.Second)
		app.Press("id:terminal-shell-picker")
		app.Advance(150 * time.Millisecond)
		shot(app, "comparison/terminal-shell-menu")
		app.WaitFor("id:terminal-shell-cmd", 5*time.Second)
		app.Press("id:terminal-shell-cmd")
		waitApp(app, "id:terminal-view", 30*time.Second)
		onNativeUI(t, app, built, func() {
			tab := built.term.activeTab()
			if tab == nil || len(tab.startCommand) != 1 || !strings.EqualFold(filepath.Base(tab.startCommand[0]), "cmd.exe") || tab.state.GetUntracked() != termRunning {
				t.Error("selecting cmd did not open a running cmd shell")
			}
		})
	} else {
		app.Press("id:terminal-new")
	}
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:terminal-tab")) == 2 })
	if got := len(app.Query("id:terminal-tab")); got != 2 {
		t.Fatalf("tabs = %d, want 2", got)
	}
	app.Press("id:terminal-hide")
	app.Advance(200 * time.Millisecond)
	if got := len(app.Query("id:terminal-view")); got != 0 {
		t.Fatalf("terminal view still shows after hiding")
	}
	app.Press("id:terminal-toggle")
	waitApp(app, "id:terminal-view", 30*time.Second)
	if got := len(app.Query("id:terminal-tab")); got != 2 {
		t.Fatalf("tabs after reopening = %d, want 2", got)
	}
	shot(app, "41-terminal")
	app.RightClick("id:terminal-tab >> nth=0")
	app.WaitFor("text:重命名标签…", 5*time.Second)
	shot(app, "comparison/terminal-tab-menu")
	app.Press("text:重命名标签…")
	app.WaitFor("id:term-rename", 5*time.Second)
	shot(app, "comparison/terminal-rename")
	app.Clear("id:term-rename-input")
	app.Type("id:term-rename-input", "对照终端")
	app.Press("id:term-rename-save")
	app.Advance(250 * time.Millisecond)
	app.WaitForGone("id:term-rename", 5*time.Second)
	app.Find("label:对照终端")

	var first, second *termTab
	onNativeUI(t, app, built, func() {
		list := built.term.tabs.GetUntracked()
		first, second = list[0], list[1]
	})
	app.Focus("id:terminal-tab >> nth=1")
	app.Key("home")
	app.Key("end")
	onNativeUI(t, app, built, func() {
		if got := built.term.active.GetUntracked(); got != second.ID {
			t.Errorf("End after Home selected %q, want %q", got, second.ID)
		}
	})
	app.Key("home")
	waitApp(app, "id:terminal-view", 30*time.Second)
	app.RightClick("id:terminal-view")
	app.Press("text:全选")
	var firstSelected, secondSelected bool
	onNativeUI(t, app, built, func() {
		firstSelected, secondSelected = first.ref.Selected(), second.ref.Selected()
	})
	if !firstSelected || secondSelected {
		t.Fatalf("after Home and Select All: first selected = %v, second = %v; want the first shell", firstSelected, secondSelected)
	}
	app.RightClick("id:terminal-tab >> nth=1")
	app.Press("text:关闭其他终端")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:terminal-tab")) == 1 })
	app.RightClick("id:terminal-tab")
	app.Press("text:关闭全部终端")
	app.WaitForGone("id:terminal-tab", 5*time.Second)
	app.WaitFor("text:还没有终端", 5*time.Second)
}
