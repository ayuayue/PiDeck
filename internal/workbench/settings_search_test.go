//go:build !js && !android && !ios

package workbench

// Checks the settings search jumps to the right section.

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestSettingsSearch(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
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
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("id:rail-palette")
	app.Type("label:命令", "一轮完成时通知")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option 设置 · 一轮完成时通知")) > 0 })
	app.Press("role:option 设置 · 一轮完成时通知")
	app.WaitFor("id:notify-done", 5*time.Second)
}

func TestSettingsNavigationResetsSectionScroll(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	screen.Press("label:设置")
	screen.WaitFor("id:settings-search", 5*time.Second)
	screen.Press("id:settings-tab-general")
	screen.WaitFor("id:notify-done", 5*time.Second)
	screen.ScrollTo("id:settings-page", core.Point{Y: 700})
	screen.WaitUntil(5*time.Second, func() bool { return built.settingsOffset.Y > 0 })

	screen.Type("id:settings-search", "内容宽度")
	screen.WaitFor("id:settings-hit-general-0", 5*time.Second)
	screen.Press("id:settings-hit-general-0")
	screen.WaitFor("id:chat-width", 5*time.Second)
	if got := built.settingsOffset.Y; got != 0 {
		t.Fatalf("settings offset after selecting a search result = %.0f, want 0", got)
	}
}

func TestSettingsNavigationHasIndependentScroll(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(900, 500))
	screen.Press("label:设置")
	screen.WaitFor("id:settings-tab-general", 5*time.Second)
	screen.ScrollTo("id:settings-page", core.Point{Y: 500})
	screen.WaitUntil(5*time.Second, func() bool { return built.settingsOffset.Y > 0 })
	pageOffset := built.settingsOffset.Y

	screen.ScrollTo("id:settings-navigation", core.Point{Y: 500})
	screen.WaitFor("id:settings-tab-about", 5*time.Second)
	if got := built.settingsOffset.Y; got != pageOffset {
		t.Fatalf("scrolling settings navigation changed page offset from %.0f to %.0f", pageOffset, got)
	}
	screen.Press("id:settings-tab-about")
	screen.WaitFor("id:settings-page", 5*time.Second)
	if got := built.settingsOffset.Y; got != 0 {
		t.Fatalf("settings offset after opening another section = %.0f, want 0", got)
	}
}
