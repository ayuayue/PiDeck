//go:build !js && !android && !ios

package workbench

// Checks the settings search jumps to the right section.

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestSettingsSearch(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.WaitFor("id:settings-search", 5*time.Second)
	app.Type("id:settings-search", "代理")
	app.WaitFor("id:settings-hit-env-0", 5*time.Second)
	app.Press("id:settings-hit-env-0")
	app.WaitFor("id:proxy-app", 5*time.Second)

	app.Type("id:settings-search", "通知")
	app.WaitFor("id:settings-hit-general-0", 5*time.Second)
	app.Press("id:settings-hit-general-0")
	app.WaitFor("id:notify-done", 5*time.Second)

	app.Type("id:settings-search", "zzzz-no-such-setting")
	app.WaitFor("text:没有匹配的设置", 5*time.Second)
}

// TestSettingsFromPalette jumps to a setting from the command palette.
func TestSettingsFromPalette(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("id:rail-palette")
	app.Type("label:命令", "一轮完成时通知")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option 设置 · 一轮完成时通知")) > 0 })
	app.Press("role:option 设置 · 一轮完成时通知")
	app.WaitFor("id:notify-done", 5*time.Second)
}
