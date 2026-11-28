//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsData puts everyday tasks first and keeps storage paths optional.
func (a *app) settingsData() core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		exporting := core.NewSignal(cx, false)
		opening := core.NewSignal(cx, false)
		locationsOpen := core.NewSignal(cx, false)
		colors := ui.ColorsOf(cx)
		unavailable := a.st == nil
		return a.scrollStashFor("settingsData:1").Bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: viewkit.PanelInset}, Gap: 2}, Children: []core.Node{
				setGroup("备份与恢复",
					setRow("备份设置", "保存设置、主题、插件等，不含会话、收藏和定时任务。",
						ui.Button{TextFunc: func() string {
							if exporting.Get() {
								return apptext.T("正在导出…")
							}
							return apptext.T("导出备份")
						}, Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "settings-export",
							Disabled: func() bool { return unavailable || exporting.Get() }, OnPress: func() {
								exporting.Set(true)
								a.exportSettings(func() { exporting.Set(false) })
							}}),
					setDivider(),
					setRow("恢复设置", "选择以前导出的 ZIP 文件；同名设置会被覆盖，部分设置需重启生效。",
						ui.Button{Text: apptext.T("选择备份…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "settings-import",
							Disabled: func() bool { return unavailable || exporting.Get() }, OnPress: a.pickSettingsZip}),
					core.Text{Content: apptext.T("这不是完整数据备份。文件可能包含密钥，请妥善保管。"), TestID: "settings-backup-note",
						Style:     core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18, Padding: core.Edges{Top: 6, Bottom: 6, Left: 2, Right: 2}},
						StyleFunc: ui.Colored(colors.Muted)},
				),
				setGroup("会话与文件",
					setRow("管理会话", "按项目查找会话，支持归档和批量整理。",
						ui.Button{Text: apptext.T("管理会话"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "data-manage-sessions",
							OnPress: func() { a.openSessionManager(nil, false) }}),
					setDivider(),
					setRow("导入会话", "导入其他工具或本机的历史会话，保留原文件。",
						ui.Button{Text: apptext.T("导入会话"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "data-import-sessions", OnPress: a.openImportDialog}),
					setDivider(),
					setRow("从目录导入会话", "选择任意会话目录，递归导入 pi 的 .jsonl 文件，保留原文件并跳过重复会话。",
						ui.Button{Text: apptext.T("选择目录…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "data-import-directory", Disabled: a.transferRunning, OnPress: a.pickSessionDirectory}),
					a.sessionTransferSettings(),
					setDivider(),
					setRow("导出文件", "查看已导出的设置备份和会话文件。",
						ui.Button{Text: apptext.T("打开文件夹"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "data-open-exports",
							Disabled: func() bool { return unavailable || opening.Get() }, OnPress: func() {
								opening.Set(true)
								a.openDataExports(func() { opening.Set(false) })
							}}),
					setDivider(),
					ui.Collapsible{Text: apptext.T("存储位置"), TestID: "data-locations", Open: locationsOpen.Get, OnOpenChange: locationsOpen.Set,
						Content: a.dataLocationRows()},
				),
				a.cacheCleanupSettings(),
			}},
		}})
	})
}

func (a *app) dataLocationRows() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		dir, sessions := "", ""
		if a.st != nil {
			dir, sessions = a.st.dir, a.st.sessions
		}
		var rows []core.Node
		for _, loc := range []struct{ id, label, path string }{
			{"data", "应用数据目录", dir},
			{"sessions", "会话目录", sessions},
			{"pi", "pi 会话目录", a.env.Get().SessionsDir},
		} {
			if loc.path == "" {
				continue
			}
			if len(rows) > 0 {
				rows = append(rows, setDivider())
			}
			rows = append(rows, setRow(loc.label, loc.path, core.View{
				Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 4}, Children: []core.Node{
					ui.Button{Text: apptext.T("复制路径"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "data-copy-" + loc.id,
						OnPress: func() { a.copyText(loc.path, "路径") }},
					ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "data-open-" + loc.id,
						OnPress: func() { a.openFolder(localTarget, loc.path) }},
				},
			}))
		}
		return core.View{Children: rows}
	})
}
