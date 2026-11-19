//go:build !js && !android && !ios

package workbench

// The tray menu: its labels, and its shape on an app with nothing open.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestTrayLabels(t *testing.T) {
	// Another test may have left the app in English.
	apptext.SetLanguage(apptext.LangZhCN)
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })

	cases := []struct{ name, path, want string }{
		{"PiDeck Lite", "/Users/me/PiDeck-Lite", "PiDeck Lite · PiDeck-Lite"},
		{"same", "/work/same", "same"},
		{"", "/work/folder", "folder"},
		{"nested", `C:\Users\me\Projects\app`, `nested · app`},
	}
	for _, c := range cases {
		if got := trayProjectLabel(c.name, c.path); got != c.want {
			t.Errorf("trayProjectLabel(%q, %q) = %q, want %q", c.name, c.path, got, c.want)
		}
	}
	if got := traySessionLabel("修一下登录", "PiDeck Lite"); got != "修一下登录 · PiDeck Lite" {
		t.Errorf("session label = %q", got)
	}
	if got := traySessionLabel("  ", ""); got != "未命名会话" {
		t.Errorf("empty session label = %q", got)
	}
	if got := traySessionLabel("only", " "); got != "only" {
		t.Errorf("session label without a project = %q", got)
	}
}

func TestTrayMenuShape(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	if built == nil {
		t.Fatal("the app did not build")
	}
	screen.Settle()

	items := built.trayMenu()
	if len(items) < 8 {
		t.Fatalf("tray menu has %d entries, want the full menu", len(items))
	}
	if !items[0].Disabled {
		t.Error("the first row is the version, which is read-only")
	}
	last := items[len(items)-1]
	if last.Label != "退出" || last.OnSelect == nil {
		t.Fatalf("last row = %+v, want 退出", last)
	}
	labels := map[string]desktopItem{}
	for _, it := range items {
		labels[it.Label] = desktopItem{disabled: it.Disabled, sub: len(it.Items)}
	}
	for _, want := range []string{"显示 PiDeck Lite", "新建会话", "最近会话", "打开项目", "定时任务", "桌面宠物",
		"打开数据目录", "打开日志目录", "设置…", "重启"} {
		if _, ok := labels[want]; !ok {
			t.Errorf("tray menu has no %q", want)
		}
	}
	// Nothing open yet: the lists say so rather than showing an empty menu.
	if !labels["最近会话"].disabled || !labels["打开项目"].disabled || !labels["定时任务"].disabled {
		t.Errorf("empty lists should be disabled: %+v", labels)
	}
}

// desktopItem is what the shape test reads off a menu row.
type desktopItem struct {
	disabled bool
	sub      int
}
