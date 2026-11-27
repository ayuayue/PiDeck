//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) settingsExternalEditors() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		adding, busy := core.NewSignal(cx, false), core.NewSignal(cx, false)
		name, path, failure := core.NewSignal(cx, ""), core.NewSignal(cx, ""), core.NewSignal(cx, "")
		save := func() {
			command, title := strings.TrimSpace(path.GetUntracked()), strings.TrimSpace(name.GetUntracked())
			if command == "" || busy.GetUntracked() {
				return
			}
			busy.Set(true)
			failure.Set("")
			a.addExternalEditor(title, command, func(err error) {
				busy.Set(false)
				if err != nil {
					failure.Set(err.Error())
					return
				}
				adding.Set(false)
				name.Set("")
				path.Set("")
			})
		}
		rows := core.Dynamic(func(cx *core.Scope) core.Node {
			list := a.editors()
			if len(list) == 0 {
				return core.Text{TestID: "editors-empty", Content: apptext.T("尚未添加编辑器。检测已安装的编辑器，或手动选择程序。"),
					Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)}
			}
			var children []core.Node
			for i, editor := range list {
				i, editor := i, editor
				key := editorKey(editor.Command)
				if i > 0 {
					children = append(children, setDivider())
				}
				children = append(children, core.View{TestID: "external-editor-" + key,
					Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 10, Padding: core.Symmetric(9, 0), MinWidth: core.Pt(0)}, Children: []core.Node{
						ui.IconOf(editorMarkOf(editor.Command), 18, colors.Text),
						core.View{Style: core.Style{Gap: 5, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
							core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8, AlignItems: core.AlignCenter}, Children: []core.Node{
								ui.Text(editor.Name, viewkit.PanelTextSize, ui.Medium, colors.Text),
								core.Show{When: func() bool { return i == 0 }, Then: func(*core.Scope) core.Node {
									return ui.Text(apptext.T("默认"), viewkit.PanelCaptionSize, ui.Medium, colors.Muted)
								}},
							}},
							core.Text{Content: editor.Command, Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18, FontFamily: viewkit.MonoFont()}, StyleFunc: ui.Colored(colors.Muted)},
							core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: []core.Node{
								core.Show{When: func() bool { return i > 0 }, Then: func(*core.Scope) core.Node {
									return ui.Button{Text: apptext.T("设为默认"), TestID: "editor-default-" + key, Variant: ui.ButtonGhost, Size: ui.SizeSmall,
										OnPress: func() { a.saveExternalEditors(list, editor.Command) }}
								}},
								ui.Button{Text: apptext.T("删除"), TestID: "editor-remove-" + key, Variant: ui.ButtonGhost, Size: ui.SizeSmall,
									OnPress: func() { a.removeExternalEditor(editor.Command) }},
							}},
						}},
					}})
			}
			return core.View{Style: core.Style{MinWidth: core.Pt(0)}, Children: children}
		})
		form := core.Show{When: adding.Get, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{Gap: 8, Padding: core.Symmetric(10, 0)}, Children: []core.Node{
				core.Input{Label: apptext.T("编辑器名称"), TestID: "editor-name", Value: name.Get, OnChange: name.Set,
					Placeholder: apptext.T("编辑器名称（可选）"), Disabled: busy.Get, Style: panelFieldStyle(colors)},
				core.Input{Label: apptext.T("编辑器程序路径"), TestID: "editor-command", Value: path.Get, OnChange: path.Set,
					Placeholder: apptext.T("可执行文件的完整路径"), Disabled: busy.Get, Style: panelFieldStyle(colors)},
				ui.Text(apptext.T("选择可执行文件或填写 PATH 中的命令名，不含启动参数。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
				core.Text{TestID: "editor-error", ContentFunc: failure.Get, Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
					ui.Button{Text: apptext.T("选择文件"), TestID: "editor-browse", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, Disabled: busy.Get, OnPress: func() {
						a.cx.PickFiles(core.PickFilesOptions{Limit: 1, Title: apptext.T("选择编辑器程序")}, func(files []core.File, err error) {
							if err != nil {
								failure.Set(err.Error())
								return
							}
							if len(files) > 0 {
								path.Set(files[0].Path)
							}
						})
					}},
					ui.Button{Text: apptext.T("添加"), TestID: "editor-save", Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
						Disabled: func() bool { return busy.Get() || strings.TrimSpace(path.Get()) == "" }, OnPress: save},
					ui.Button{Text: apptext.T("取消"), TestID: "editor-cancel", Variant: ui.ButtonGhost, Size: ui.SizeSmall, Disabled: busy.Get,
						OnPress: func() { adding.Set(false); failure.Set("") }},
				}},
			}}
		}}
		return core.View{Style: core.Style{Gap: 8, MinWidth: core.Pt(0)}, Children: []core.Node{
			ui.Text(apptext.T("用于在外部打开项目和文件。列表首项为默认编辑器，删除仅移除此处记录。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted), rows,
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
				ui.Button{Text: apptext.T("检测编辑器"), TestID: "editor-detect", Icon: lucide.RefreshCw, Variant: ui.ButtonSecondary, Size: ui.SizeSmall, Disabled: busy.Get, OnPress: func() {
					busy.Set(true)
					a.rescanExternalEditors(func() { busy.Set(false) })
				}},
				ui.Button{Text: apptext.T("添加编辑器"), TestID: "editor-add", Icon: lucide.Plus, Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					OnPress: func() { adding.Set(true) }},
			}}, form,
		}}
	})
}
