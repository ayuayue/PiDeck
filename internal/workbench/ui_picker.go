//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// pickerDialog is the folder and session file browser.
func (a *app) pickerDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		p := a.pick
		importing := p.mode.Get() == "import"
		title := apptext.T("添加工作区")
		sub := apptext.T("选一个项目文件夹；会话会在它的目录里运行。")
		if importing {
			title = apptext.T("导入会话")
			sub = apptext.T("选一个 pi、Codex 或 Claude 的 .jsonl 会话文件；会转换并复制到本应用自己的会话目录，不改动原文件。")
		}
		row := func(e pickEntry) core.Node {
			selected := func() bool { return p.selected.Get() == e.Path }
			return core.View{
				OnPress: func(core.PressEvent) {
					if e.Dir {
						p.load(e.Path)
						return
					}
					if importing {
						p.selected.Set(e.Path)
					}
				},
				Role: core.RoleButton, Label: e.Name,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(30),
						Padding: core.Symmetric(0, 10), CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()}}
					if selected() {
						st.Background = colors.Pressed()
					}
					return st
				},
				Children: []core.Node{
					ui.IconOf(func() *core.SVG {
						if e.Dir {
							return lucide.Folder()
						}
						return lucide.FileText()
					}, 14, func() core.Color {
						if e.Dir {
							return colors.Muted()
						}
						return colors.Faint()
					}),
					core.Text{Content: e.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return !e.Dir && importing }, Then: func(*core.Scope) core.Node {
						return core.Text{Content: apptext.T("会话"), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
					}},
				},
			}
		}
		var rows []core.Node
		rows = append(rows, core.Show{When: func() bool { return len(p.visible()) == 0 }, Then: func(*core.Scope) core.Node {
			return core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(apptext.T("这个文件夹是空的"), 12, ui.Regular, colors.Faint),
			}}
		}})
		rows = append(rows, core.Each(func() []pickEntry { return p.visible() }, func(e pickEntry) string { return e.Path },
			func(cx *core.Scope, e func() pickEntry, _ func() int) core.Node { return row(e()) }))
		places := p.places(a.workspaces.Get())
		var placeChips []core.Node
		for _, pl := range places {
			entry := pl
			placeChips = append(placeChips, core.View{
				OnPress: func(core.PressEvent) { p.load(entry.Path) },
				Role:    core.RoleButton, Label: entry.Name,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), Padding: core.Symmetric(0, 9),
						CornerRadius: 13, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{ui.Icon(lucide.FolderGit2, 11, colors.Muted), ui.Text(entry.Name, 11.5, ui.Regular, colors.Muted)},
			})
		}
		primary := apptext.T("选择这个文件夹")
		if importing {
			primary = apptext.T("导入")
		}
		return ui.Dialog{
			Open:         p.open.Get,
			OnOpenChange: func(open bool, _ base.Reason) { p.open.Set(open) },
			Title:        title,
			Description:  sub,
			TestID:       "picker",
			Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: placeChips},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.View{StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0),
							Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7, Background: colors.Field(),
							BorderWidth: 1, BorderColor: colors.FieldBorder()}
					}, Children: []core.Node{
						ui.Icon(lucide.Folder, 13, colors.Faint),
						core.Input{
							Value: p.addr.Get, OnChange: p.addr.Set, Placeholder: apptext.T("输入路径后回车"),
							Label: apptext.T("文件夹路径"), SubmitBehavior: core.SubmitBehaviorSubmit,
							OnSubmit: func(text string) { p.load(text) },
							Style:    core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 12, Color: colors.Text()},
							StyleFunc: func() core.Style {
								return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
							},
						},
					}},
					hintOf(func() string { return apptext.T("上一级") }, ui.IconButton{Icon: lucide.ArrowUp, Label: apptext.T("上一级"), Size: 28, IconSize: 14, OnPress: p.up}),
					hintOf(func() string { return apptext.T("刷新") }, ui.IconButton{Icon: lucide.RefreshCw, Label: apptext.T("刷新"), Size: 28, IconSize: 13, OnPress: func() { p.load(p.path.GetUntracked()) }}),
					hintOf(func() string { return apptext.T("显示隐藏文件") }, ui.IconButton{Icon: lucide.Eye, Label: apptext.T("显示隐藏文件"), Size: 28, IconSize: 13,
						Selected: p.hidden.Get, OnPress: func() { p.hidden.Update(func(v bool) bool { return !v }) }}),
				}},
				core.View{Style: core.Style{Height: core.Pt(300), MinHeight: core.Pt(0), BorderWidth: 1, BorderColor: colors.Border(),
					CornerRadius: ui.RadiusControl, Overflow: core.Hidden, Background: colors.Background()}, Children: []core.Node{
					a.scrollStashFor("pickerDialog:1").Bind(cx, core.Scroll{Style: ui.FillRest, Children: []core.Node{
						core.View{Style: core.Style{Padding: core.All(4), Gap: 1}, Children: rows},
					}}),
				}},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(16)}, Children: []core.Node{
					core.Show{When: func() bool { return p.loading.Get() }, Then: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
							ui.Spinner{Size: 11}, ui.Text(apptext.T("读取中…"), 11.5, ui.Regular, colors.Faint),
						}}
					}},
					core.Text{ContentFunc: func() string { return p.err.Get() }, MaxLines: 2, Style: core.Style{FlexShrink: 1, FontSize: 11},
						StyleFunc: ui.Colored(colors.Danger)},
				}},
			},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("系统选择器"), Variant: ui.ButtonGhost, TestID: "picker-native", OnPress: func() {
					mode := p.mode.GetUntracked()
					p.open.Set(false)
					a.pickNative(mode)
				}},
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, OnPress: func() { p.open.Set(false) }},
				ui.Button{Text: primary, Variant: ui.ButtonPrimary, Disabled: func() bool { _, ok := p.chosen(); return !ok },
					TestID: "picker-choose", OnPress: func() {
						if path, ok := p.chosen(); ok {
							a.pickerChosen(path)
						}
					}},
			},
		}
	})
}
