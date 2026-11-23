//go:build !js && !android && !ios

package workbench

// The ACP preset manager: the built-ins for reference, the presets the
// user added, and a small form that writes acp/presets.json.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// openACPPresetManager shows the manager with empty fields.
func (a *app) openACPPresetManager() {
	a.acpNewID.Set("")
	a.acpNewName.Set("")
	a.acpNewCommand.Set("")
	a.acpNewArgs.Set("")
	a.acpManageErr.Set("")
	a.acpManageOpen.Set(true)
	a.refreshACPManager()
}

// acpPresetManagerDialog adds and removes custom presets.
func (a *app) acpPresetManagerDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		fieldStyle := core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
			FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
			BorderWidth: 1, BorderColor: colors.FieldBorder()}
		field := func(value func() string, set func(string), placeholder, label, testID string) core.Node {
			return core.Input{Value: value, OnChange: set, Placeholder: placeholder, Label: label, TestID: testID, Style: fieldStyle}
		}
		row := func(p acpPreset, editable bool) core.Node {
			return core.Dynamic(func(cx *core.Scope) core.Node {
				snapshot := a.acpManager.Get()
				installing := a.acpInstalling.Get()
				args := strings.Join(p.Args, " ")
				meta := p.Command
				if args != "" {
					meta += " " + args
				}
				status := snapshot.status[p.ID]
				if !snapshot.checked {
					status.label = apptext.T("检测中…")
				}
				ink := colors.Up()
				if !status.ready {
					ink = colors.Warn()
				}
				children := []core.Node{
					ui.Icon(lucide.Bot, 13, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: p.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: meta, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
						core.Text{Content: status.label, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(func() core.Color { return ink })},
					}},
				}
				if _, canInstall := acpPresetInstallArgs(p.ID); !editable && canInstall && snapshot.checked && !status.ready && snapshot.npm {
					label := apptext.T("安装")
					if installing == p.ID {
						label = apptext.T("正在安装…")
					}
					children = append(children, ui.Button{Text: label, Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "acp-preset-install-run-" + p.ID, Disabled: func() bool { return a.acpInstalling.Get() != "" },
						OnPress: func() { a.installACPPreset(p.ID, p.Name) }})
				} else if cmd := acpPresetInstall(p); !editable && cmd != "" {
					children = append(children, ui.Button{Text: apptext.T("复制安装命令"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						TestID: "acp-preset-install-" + p.ID, OnPress: func() { a.copyText(cmd, apptext.T("安装命令")) }})
				}
				if p.Homepage != "" {
					url := p.Homepage
					children = append(children, ui.Button{Text: apptext.T("文档"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						TestID: "acp-preset-docs-" + p.ID, OnPress: func() { a.cx.OpenURL(url, nil) }})
				}
				if editable {
					id := p.ID
					children = append(children, ui.Button{Text: apptext.T("删除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						TestID: "acp-preset-remove-" + id, Disabled: a.acpManageBusy.Get, OnPress: func() { a.removeACPPreset(id) }})
				} else {
					children = append(children, core.View{Style: core.Style{Padding: core.Symmetric(1, 6), CornerRadius: 4, Background: colors.Inset()},
						Children: []core.Node{ui.Text(apptext.T("内置"), 9, ui.Medium, colors.Faint)}})
				}
				return core.View{TestID: "acp-preset-row-" + p.ID,
					Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(42),
						Padding: core.Symmetric(3, 4)}, Children: children}
			})
		}
		var builtinRows []core.Node
		for _, p := range acpPresets() {
			builtinRows = append(builtinRows, row(p, false))
		}
		custom := core.Dynamic(func(cx *core.Scope) core.Node {
			var customRows []core.Node
			for _, p := range a.acpManager.Get().custom {
				customRows = append(customRows, row(p, true))
			}
			if len(customRows) == 0 {
				customRows = append(customRows, core.Text{Content: apptext.T("还没有自定义预设。"), Style: core.Style{FontSize: 11, Padding: core.Symmetric(6, 4)},
					StyleFunc: ui.Colored(colors.Faint)})
			}
			return core.View{Style: core.Style{Gap: 1}, Children: customRows}
		})
		body := []core.Node{
			core.Text{Content: apptext.T("预设只是一条启动命令：标着 npx 的第一次运行会自己下载；其余需要本机装好并登录该 CLI。状态按本机 PATH 检查。"),
				Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)},
			ui.Text(apptext.T("自定义"), 10.5, ui.Medium, colors.Muted),
			custom,
			core.View{Style: core.Style{Gap: 6, Margin: core.Edges{Top: 6}}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						field(a.acpNewID.Get, a.acpNewID.Set, "my-agent", "预设 id", "acp-preset-id")}},
					core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						field(a.acpNewName.Get, a.acpNewName.Set, "我的 Agent", "预设名称", "acp-preset-name")}},
				}},
				field(a.acpNewCommand.Get, a.acpNewCommand.Set, "npx / my-agent", "命令", "acp-preset-command"),
				field(a.acpNewArgs.Get, a.acpNewArgs.Set, "-y @scope/agent-acp（空格分隔）", "参数", "acp-preset-args"),
				core.Show{When: func() bool { return a.acpManageErr.Get() != "" }, Then: func(*core.Scope) core.Node {
					return core.Text{Content: a.acpManageErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 11, LineHeight: 16},
						StyleFunc: ui.Colored(colors.Danger)}
				}},
				core.View{Style: core.Style{Direction: core.Row, JustifyContent: core.JustifyEnd}, Children: []core.Node{
					ui.Button{Text: apptext.T("添加"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "acp-preset-add",
						Disabled: a.acpManageBusy.Get, OnPress: a.addACPPreset},
				}},
			}},
			ui.Text(apptext.T("内置"), 10.5, ui.Medium, colors.Muted),
			core.View{Style: core.Style{Gap: 1}, Children: builtinRows},
		}
		return ui.Dialog{
			Open:         a.acpManageOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.acpManageOpen.Set(open) },
			Title:        apptext.T("管理 ACP 预设"),
			TestID:       "acp-preset-manager",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(660)},
			Children: []core.Node{core.Scroll{Style: core.Style{MaxHeight: core.Pt(520)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 6}, Children: body}}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("检测"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "acp-preset-check", OnPress: a.refreshACPManager},
				ui.Button{Text: apptext.T("打开预设目录"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.openACPDir() }},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "acp-preset-close",
					OnPress: func() { a.acpManageOpen.Set(false) }},
			},
		}
	})
}
