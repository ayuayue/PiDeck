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

// TestSettingsSearchFindsSections checks a section stays reachable by its
// own name, even when none of its settings names it.
func TestSettingsSearchFindsSections(t *testing.T) {
	for _, tt := range []struct{ query, section string }{
		{"用量", "usage"}, {"远程", "remote"}, {"通用", "general"},
	} {
		hits := searchSettings(tt.query)
		if len(hits) != 1 || !hits[0].Jump || hits[0].Section != tt.section {
			t.Fatalf("searchSettings(%q) = %+v, want the %s section alone", tt.query, hits, tt.section)
		}
	}
	if hits := searchSettings("代理"); len(hits) < 2 || hits[0].Jump {
		t.Fatalf("searchSettings(代理) = %+v, want the settings named by it", hits)
	}
	if hits := searchSettings("  "); hits != nil {
		t.Fatalf("an empty query lists %+v, want nothing", hits)
	}
}

// TestSettingsSearchJumpsToSection opens a section from its name.
func TestSettingsSearchJumpsToSection(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.WaitFor("id:settings-search", 5*time.Second)
	app.Type("id:settings-search", "远程")
	app.WaitFor("id:settings-hit-remote-0", 5*time.Second)
	app.Press("id:settings-hit-remote-0")
	app.WaitFor("id:remote-enabled", 5*time.Second)
	if app.Exists("id:settings-hit-remote-0") {
		t.Fatal("the search results stay after opening the section they named")
	}
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
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find("id:settings-page").Offset.Y > 0 })

	screen.Type("id:settings-search", "内容宽度")
	screen.WaitFor("id:settings-hit-general-0", 5*time.Second)
	screen.Press("id:settings-hit-general-0")
	screen.WaitFor("id:chat-width", 5*time.Second)
	if got := screen.Find("id:settings-page").Offset.Y; got != 0 {
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
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find("id:settings-page").Offset.Y > 0 })
	pageOffset := screen.Find("id:settings-page").Offset.Y

	screen.ScrollTo("id:settings-navigation", core.Point{Y: 500})
	screen.WaitFor("id:settings-tab-about", 5*time.Second)
	if got := screen.Find("id:settings-page").Offset.Y; got != pageOffset {
		t.Fatalf("scrolling settings navigation changed page offset from %.0f to %.0f", pageOffset, got)
	}
	screen.Press("id:settings-tab-about")
	screen.WaitFor("id:settings-page", 5*time.Second)
	if got := screen.Find("id:settings-page").Offset.Y; got != 0 {
		t.Fatalf("settings offset after opening another section = %.0f, want 0", got)
	}
}
