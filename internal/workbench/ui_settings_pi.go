//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsPiRuntime keeps the custom-path draft outside the probe subtree.
func (a *app) settingsPiRuntime() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		editing := core.NewSignal(cx, false)
		draft := core.NewSignal(cx, a.cfg.PiExecutable)
		status := core.Dynamic(func(cx *core.Scope) core.Node {
			a.settingsTick()
			info := a.env.Get()
			label, icon, ink := apptext.T("检测中…"), lucide.LoaderCircle, colors.Muted
			switch {
			case info.Probing:
			case info.PiError != "" && info.PiPath != "":
				label, icon, ink = apptext.T("pi 无法运行"), lucide.CircleAlert, colors.Danger
			case info.PiError != "" || info.Probed && info.PiPath == "":
				label, icon, ink = apptext.T("未找到 pi"), lucide.CircleAlert, colors.Danger
			case info.PiPath != "":
				label, icon, ink = apptext.T("pi 已就绪"), lucide.CircleCheck, colors.Text
			}
			source := apptext.T("从 PATH 自动检测")
			if a.cfg.PiExecutable != "" {
				source = apptext.T("使用自定义程序")
			}
			rows := []core.Node{
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
					ui.IconOf(icon, 15, ink), ui.Text(label, viewkit.PanelTextSize, ui.Medium, ink),
					core.Show{When: func() bool { return info.PiVersion != "" && info.PiError == "" && !info.Probing }, Then: func(*core.Scope) core.Node {
						return core.Text{TestID: "pi-version", Content: "pi " + info.PiVersion, Style: core.Style{FontSize: viewkit.PanelCaptionSize, FontFamily: viewkit.MonoFont()}, StyleFunc: ui.Colored(colors.Muted)}
					}},
				}},
				ui.Text(source, viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
			}
			path := info.PiPath
			if path == "" {
				path = a.cfg.PiExecutable
			}
			if path != "" {
				rows = append(rows, core.Text{TestID: "pi-path", Content: path,
					Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18, FontFamily: viewkit.MonoFont(), MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Text)})
			}
			if info.PiError != "" && !info.Probing {
				rows = append(rows, core.Text{TestID: "pi-error", Content: info.PiError, Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)},
					ui.Text(apptext.T("安装 pi 后重新检测，或选择已有程序。切换仅影响之后启动的本机会话。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted))
			}
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8, Margin: core.Edges{Top: 4}}, Children: []core.Node{
				ui.Button{Text: apptext.T("重新检测"), TestID: "pi-recheck", Icon: lucide.RefreshCw, Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					Disabled: func() bool { return info.Probing }, OnPress: a.reprobePiRuntime},
				ui.Button{Text: apptext.T("更换程序"), TestID: "pi-change", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
					draft.Set(a.cfg.PiExecutable)
					editing.Set(true)
				}},
				core.Show{When: func() bool { return info.PiError != "" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: apptext.T("安装说明"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.cx.OpenURL("https://pi.dev/", nil) }}
				}},
				core.Show{When: func() bool { return a.cfg.PiExecutable != "" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: apptext.T("恢复自动检测"), TestID: "pi-auto", Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						OnPress: func() { editing.Set(false); a.setPiExecutable("") }}
				}},
			}})
			if info.PiPath != "" && info.PiError == "" && !info.Probing {
				rows = append(rows, a.piUpdateSetting(true))
			}
			return core.View{Style: core.Style{Gap: 6, MinWidth: core.Pt(0)}, Children: rows}
		})
		form := core.Show{When: editing.Get, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{Gap: 8, Padding: core.Symmetric(10, 0)}, Children: []core.Node{
				ui.Text(apptext.T("选择 pi 可执行文件或填写完整路径，不含启动参数。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
				core.Input{Label: apptext.T("pi 程序路径"), TestID: "pi-executable", Value: draft.Get, OnChange: draft.Set,
					Placeholder: apptext.T("可执行文件的完整路径"), Style: panelFieldStyle(colors)},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
					ui.Button{Text: apptext.T("选择文件"), TestID: "pi-browse", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
						a.cx.PickFiles(core.PickFilesOptions{Limit: 1, Title: apptext.T("选择 pi 程序")}, func(files []core.File, err error) {
							if err != nil {
								a.toast(ui.ToastError, apptext.T("选择文件失败"), err.Error())
								return
							}
							if len(files) > 0 {
								draft.Set(files[0].Path)
							}
						})
					}},
					ui.Button{Text: apptext.T("应用并检测"), TestID: "pi-apply", Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
						Disabled: func() bool { return strings.TrimSpace(draft.Get()) == "" }, OnPress: func() { editing.Set(false); a.setPiExecutable(draft.GetUntracked()) }},
					ui.Button{Text: apptext.T("取消"), TestID: "pi-cancel", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { editing.Set(false) }},
				}},
			}}
		}}
		return core.View{Style: core.Style{Gap: 4, MinWidth: core.Pt(0)}, Children: []core.Node{status, form,
			core.Show{When: func() bool { return a.env.Get().PiError == "" }, Then: func(*core.Scope) core.Node {
				return ui.Text(apptext.T("切换程序仅影响新启动的本机会话，已运行的进程保持不变。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted)
			}}}}
	})
}
