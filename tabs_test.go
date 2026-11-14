package main

// Checks the tab bar's right-click menu: closing the others and all.

import (
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestTabMenuTranslations(t *testing.T) {
	for _, key := range []string{"关闭标签页", "关闭其他标签", "关闭右侧标签", "关闭全部标签"} {
		if messages[langEnUS][key] == "" || messages[langZhTW][key] == "" {
			t.Fatalf("%q has no en-US or zh-TW translation", key)
		}
	}
}

func TestTabMenu(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	app.Key("mod+n")
	app.Key("mod+n")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:tab")) == 3 })
	for i := 0; i < 4; i++ {
		app.RightClick("id:tab >> nth=0")
		if waitQuiet(app, "text:关闭其他标签", 2*time.Second) {
			break
		}
	}
	app.WaitFor("text:关闭其他标签", 15*time.Second)
	app.Press("text:关闭其他标签")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:tab")) == 1 })
	for i := 0; i < 4; i++ {
		app.RightClick("id:tab >> nth=0")
		if waitQuiet(app, "text:关闭全部标签", 2*time.Second) {
			break
		}
	}
	app.WaitFor("text:关闭全部标签", 15*time.Second)
	app.Press("text:关闭全部标签")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:tab")) == 0 })
}

// TestReopenTab brings back the last closed session tab.
func TestReopenTab(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	app.Key("mod+n")
	app.Key("mod+n")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:tab")) == 3 })
	app.Key("mod+w")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:tab")) == 2 })
	app.Key("mod+alt+t")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:tab")) == 3 })
}
