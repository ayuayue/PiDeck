package main

// Checks the terminal tab bar's right-click menu.

import (
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestTerminalTabMenu(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	app.Key("ctrl+shift+t")
	app.WaitFor("id:terminal-tab", 10*time.Second)
	app.Press("id:rail-palette")
	app.Type("label:命令", "新建终端")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option")) > 0 })
	app.Press("role:option >> nth=0")
	app.Press("id:rail-palette")
	app.Type("label:命令", "新建终端")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option")) > 0 })
	app.Press("role:option >> nth=0")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:terminal-tab")) == 3 })
	for i := 0; i < 4; i++ {
		app.RightClick("id:terminal-tab >> nth=0")
		if waitQuiet(app, "text:关闭其他终端", 2*time.Second) {
			break
		}
	}
	app.WaitFor("text:关闭其他终端", 15*time.Second)
	app.Press("text:关闭其他终端")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:terminal-tab")) == 1 })
	for i := 0; i < 4; i++ {
		app.RightClick("id:terminal-tab >> nth=0")
		if waitQuiet(app, "text:关闭全部终端", 2*time.Second) {
			break
		}
	}
	app.WaitFor("text:关闭全部终端", 15*time.Second)
	app.Press("text:关闭全部终端")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:terminal-tab")) == 0 })
}
