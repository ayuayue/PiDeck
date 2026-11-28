//go:build !js && !android && !ios

package workbench

import (
	"testing"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func settingsToolsFixture(t *testing.T, page string, dark bool) (*nsgotest.App, *app) {
	t.Helper()
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		cx.SetTheme(viewkit.Theme())
		if dark {
			cx.SetAppearance(core.AppearanceDark)
		} else {
			cx.SetAppearance(core.AppearanceLight)
		}
		built = &app{
			cx: cx, settingsRev: core.NewSignal(cx, 0),
			chatWidthPctSig: core.NewSignal(cx, chatWidthPctDefault),
			plugins:         core.NewSignalFunc(cx, []plugin{}, nil),
			pluginArchive:   core.NewSignalFunc(cx, pluginArchiveSnapshot{}, nil), pluginFileBusy: core.NewSignal(cx, false),
			resourcesLoaded: true, resourcesLoading: core.NewSignal(cx, false), piExtUpdateBusy: core.NewSignal(cx, false),
			resources: core.NewSignalFunc(cx, resourceReport{Extensions: []extensionInfo{
				{Source: "npm:active", Bare: "npm:active", Enabled: true},
				{Source: "npm:paused", Bare: "npm:paused", Enabled: false},
			}}, nil),
			mcpAddOpen: core.NewSignal(cx, true), mcpAddBusy: core.NewSignal(cx, false), mcpAddErr: core.NewSignal(cx, ""),
			mcpName: core.NewSignal(cx, "docs"), mcpURL: core.NewSignal(cx, "https://example.com/mcp"),
			mcpCommand: core.NewSignal(cx, ""), mcpDesc: core.NewSignal(cx, "Project docs"), mcpLocal: core.NewSignal(cx, false),
		}
		var body core.Node
		switch page {
		case "mcp":
			body = built.mcpDialog()
		case "resources":
			body = built.settingsResources()
		case "addons":
			body = built.settingsAddons()
		default:
			t.Fatalf("unknown fixture page %q", page)
		}
		// Exercise a narrow settings content column inside the desktop window.
		if page != "mcp" {
			body = core.View{Style: ui.FillRest.Merge(core.Style{Width: core.Pt(420)}), Children: []core.Node{body}}
		}
		return core.View{Style: ui.FillRest.Merge(core.Style{FontFamily: cx.Theme().Sans}), StyleFunc: func() core.Style {
			return core.Style{Background: ui.ColorsOf(cx).Background()}
		}, Children: []core.Node{body}}
	}, nsgotest.Size(960, 640), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	return screen, built
}

func TestMCPAddBusyKeepsForm(t *testing.T) {
	screen, built := settingsToolsFixture(t, "mcp", false)
	screen.WaitFor("id:mcp-dialog", 5*time.Second)
	screen.Post(func() { built.mcpAddBusy.Set(true) })
	screen.WaitUntil(5*time.Second, func() bool { return built.mcpAddBusy.GetUntracked() })
	screen.Key("Escape")
	if !built.mcpAddOpen.GetUntracked() {
		t.Fatal("Escape dismissed an in-flight MCP add form")
	}
	if !screen.Find("id:mcp-cancel").Props.Disabled {
		t.Fatal("cancel remains available while the add operation is running")
	}
	screen.Post(built.openMCPAdd)
	screen.Settle()
	if !built.mcpAddBusy.GetUntracked() || built.mcpName.GetUntracked() != "docs" || built.mcpURL.GetUntracked() != "https://example.com/mcp" {
		t.Fatal("reopening the MCP form discarded the in-flight operation or its fields")
	}
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-mcp-adding")
	}
	screen.Post(func() {
		built.mcpAddBusy.Set(false)
		built.mcpAddErr.Set("Connection refused")
	})
	screen.WaitUntil(5*time.Second, func() bool { return !screen.Find("id:mcp-cancel").Props.Disabled })
	screen.Press("id:mcp-cancel")
	screen.WaitForGone("id:mcp-dialog", 5*time.Second)
	screen.Post(built.openMCPAdd)
	screen.WaitFor("id:mcp-dialog", 5*time.Second)
	if built.mcpName.GetUntracked() != "" || built.mcpAddErr.GetUntracked() != "" {
		t.Fatal("a new idle form retained fields or errors from the previous operation")
	}
	screen.Key("Escape")
	screen.WaitForGone("id:mcp-dialog", 5*time.Second)
}

func TestSettingsExtensionPackageState(t *testing.T) {
	screen, built := settingsToolsFixture(t, "resources", true)
	screen.WaitFor("id:settings-page", 5*time.Second)
	if len(screen.Query("id:extension-toggle-npm-paused")) != 0 {
		t.Fatal("a pi-managed package must not offer an unsupported local toggle")
	}
	if screen.Find("id:extension-status-npm-paused").Text != apptext.T("已停用") {
		t.Fatal("a disabled pi package is not labelled as disabled")
	}
	if screen.Find("id:extension-status-npm-active").Text != apptext.T("自动加载") {
		t.Fatal("an enabled package lost its automatic-loading state")
	}
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-extension-package-state")
	}
	screen.Post(func() {
		report := built.resources.GetUntracked()
		report.Extensions = append([]extensionInfo(nil), report.Extensions...)
		report.Extensions[1].Enabled = true
		built.resources.Set(report)
	})
	screen.WaitUntil(5*time.Second, func() bool {
		return screen.Find("id:extension-status-npm-paused").Text == apptext.T("自动加载")
	})
}

func TestSettingsPluginActionsFitNarrowColumn(t *testing.T) {
	before := apptext.CurrentLanguage()
	apptext.SetLanguage(apptext.LangRuRU)
	t.Cleanup(func() { apptext.SetLanguage(before) })
	screen, _ := settingsToolsFixture(t, "addons", false)
	screen.WaitFor("id:plugin-new", 5*time.Second)
	page := screen.Find("id:settings-page")
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-plugin-actions-russian")
	}
	if page.Content.Width > page.Bounds().Size.Width+1 {
		t.Fatalf("plugin actions overflow the settings column: content=%v viewport=%v", page.Content, page.Bounds())
	}
	for _, label := range []string{"Новый плагин...", "Рынок плагинов...", "Открыть папку плагинов", "Перезарядка"} {
		button := screen.Find("role:button " + label).Bounds()
		if button.Origin.X < page.Bounds().Origin.X || button.Origin.X+button.Size.Width > page.Bounds().Origin.X+page.Bounds().Size.Width+1 {
			t.Fatalf("plugin action %q is outside the settings column: %v", label, button)
		}
	}
}
