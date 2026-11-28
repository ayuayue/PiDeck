//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/tsx"
	"github.com/nsgo-dev/nsgo/tsx/pkg"
	"github.com/nsgo-dev/nsgo/ui"
)

// The inline preview's state belongs to the settings page. Closing it or
// leaving the page disposes all three runtimes and drops pending callbacks.
func pluginPreviewSection() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		open := core.NewSignal(cx, false)
		return setGroup("NSGo 插件预览",
			setRow("会话统计示例", "内置面板、徽标和函数使用固定演示数据，不读取真实会话。",
				ui.Button{Text: apptext.T("打开预览"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "plugin-preview-open", Disabled: open.Get, OnPress: func() { open.Set(true) }}),
			core.Show{When: open.Get, Then: func(cx *core.Scope) core.Node {
				return pluginPreviewContent(cx, func() { open.Set(false) })
			}},
		)
	})
}

func pluginPreviewContent(cx *core.Scope, close func()) core.Node {
	colors := ui.ColorsOf(cx)
	state := newPluginPreview(cx)
	return core.View{TestID: "plugin-preview", Style: core.Style{Gap: 8, Padding: core.Symmetric(8, 2)}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			ui.Switch{Checked: state.grant.Get, OnChange: state.grant.Set, Label: apptext.T("允许读取演示摘要"), Size: ui.SizeSmall, TestID: "plugin-preview-grant"},
			ui.Text(apptext.T("允许读取演示摘要"), 11, ui.Regular, colors.Text),
			ui.Button{Text: apptext.T("关闭预览"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "plugin-preview-close", OnPress: close},
		}},
		core.Dynamic(func(cx *core.Scope) core.Node {
			result := state.ready.Get()
			if result.err != nil {
				return core.Text{Content: apptext.T("示例加载失败，请关闭预览后重试。"), TestID: "plugin-preview-error",
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Danger)}
			}
			if result.pkg == nil {
				return ui.Text(apptext.T("正在验证内置示例…"), 11, ui.Regular, colors.Muted)
			}
			// Reading the grant here remounts every runtime when it changes.
			// Each scope also rechecks the live value in its host handler.
			state.grant.Get()
			return core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				pluginPreviewView(cx, result.pkg, "SessionPanel", state.grant.GetUntracked),
				pluginPreviewView(cx, result.pkg, "SessionBadge", state.grant.GetUntracked),
				pluginPreviewFunction(result.pkg, state.grant.GetUntracked),
			}}
		}),
	}}
}

func pluginPreviewView(cx *core.Scope, p *pkg.Package, export string, allowed func() bool) core.Node {
	colors := ui.ColorsOf(cx)
	// Give each view a bounded slot so the sandbox cannot stretch over the
	// permission switch or sibling controls, even inside the settings scroll.
	height := core.Points(220)
	if export == "SessionBadge" {
		height = 128
	}
	return core.View{TestID: "plugin-preview-slot-" + export, Style: core.Style{Height: core.Pt(height)}, Children: []core.Node{
		core.Catch{Try: func(cx *core.Scope) core.Node {
			return tsx.View{Package: p, Export: export, Props: map[string]any{"copy": pluginPreviewCopy()},
				Sandbox: pluginPreviewSandbox(cx, allowed)}
		}, Fallback: func(_ *core.Scope, err error, _ func()) core.Node {
			return core.Text{Content: apptext.T("示例组件加载失败：%s", err.Error()), TestID: "plugin-preview-view-error-" + export,
				Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Danger)}
		}},
	}}
}

func pluginPreviewFunction(p *pkg.Package, allowed func() bool) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		state := newPluginPreviewFunction(cx, p, allowed)
		return core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
			ui.Button{Text: apptext.T("调用统计函数"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "plugin-preview-call",
				Disabled: state.disabled, OnPress: state.call},
			core.Text{ContentFunc: state.status.Get, Role: core.RoleStatus, TestID: "plugin-preview-function-result",
				Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Text)},
		}}
	})
}

func pluginPreviewCopy() map[string]string {
	return map[string]string{
		"title": apptext.T("会话统计"), "totals": apptext.T("{sessions} 个会话 · {messages} 条消息"),
		"backends": apptext.T("pi：{pi} · ACP：{acp}"), "badge": apptext.T("会话数：{sessions}"),
		"empty": apptext.T("暂无统计"), "waiting": apptext.T("等待刷新"), "busy": apptext.T("正在读取摘要…"),
		"updated": apptext.T("已更新"), "denied": apptext.T("宿主未授予会话摘要权限"),
		"refresh": apptext.T("刷新统计"), "refreshBadge": apptext.T("刷新徽标"),
	}
}
