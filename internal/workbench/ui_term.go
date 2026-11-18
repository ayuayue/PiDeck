//go:build !js && !android && !ios

package workbench

// The terminal panel and the actions its header, menus and the palette
// call.

import (
	"fmt"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	sgt "github.com/nsgo-dev/nsgo/base/terminal"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// addTerminalTab opens a tab running in a workspace, or in the home
// directory when there is none.
func (a *app) addTerminalTab(ws *workspace) *termTab {
	a.animateNextLayout()
	cwd, t := "", localTarget
	if ws != nil {
		cwd, t = ws.Path, ws.Target
	}
	tab := a.term.newTab(cwd, t)
	a.term.open.Set(true)
	a.remember()
	return tab
}

// newTerminalTab opens a tab in the active project.
func (a *app) newTerminalTab() *termTab { return a.addTerminalTab(a.activeWorkspace()) }

// openTerminalFor opens the panel on a project's folder.
func (a *app) openTerminalFor(ws *workspace) {
	a.term.open.Set(true)
	a.addTerminalTab(ws)
}

// toggleTerminal shows or hides the panel, starting a tab the first time.
func (a *app) toggleTerminal() {
	if a.term.open.GetUntracked() {
		a.animateNextLayout()
		a.term.open.Set(false)
		a.remember()
		return
	}
	a.animateNextLayout()
	a.term.open.Set(true)
	if len(a.term.tabs.GetUntracked()) == 0 {
		a.newTerminalTab()
		return
	}
	a.remember()
}

// closeTerminalTab ends one tab's shell.
func (a *app) closeTerminalTab(id string) {
	a.animateNextLayout()
	a.term.remove(id)
}

// askTerminalName opens the rename dialog for a tab.
func (a *app) askTerminalName(t *termTab) {
	if t == nil {
		return
	}
	a.termRenameID.Set(t.ID)
	a.termRenameText.Set(t.Title.GetUntracked())
	a.termRenameOpen.Set(true)
}

// saveTerminalName names the tab, and stops the shell renaming it.
func (a *app) saveTerminalName() {
	id := a.termRenameID.GetUntracked()
	name := strings.TrimSpace(a.termRenameText.GetUntracked())
	for _, t := range a.term.tabs.GetUntracked() {
		if t.ID != id {
			continue
		}
		if name == "" {
			t.named = false
		} else {
			t.named = true
			t.Title.Set(name)
		}
		break
	}
	a.termRenameOpen.Set(false)
}

// terminalRenameDialog edits a terminal tab's name.
func (a *app) terminalRenameDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return ui.Dialog{
			Open:         a.termRenameOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.termRenameOpen.Set(open) },
			Title:        apptext.T("重命名标签"),
			TestID:       "term-rename",
			Style:        core.Style{Width: core.Pt(420)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				core.Text{Content: apptext.T("给终端标签起一个名字；清空就跟随程序标题。"), Style: core.Style{FontSize: 11.5},
					StyleFunc: ui.Colored(colors.Muted)},
				core.Input{Value: a.termRenameText.Get, OnChange: a.termRenameText.Set, Placeholder: apptext.T("标签名称"),
					Label: apptext.T("标签名称"), TestID: "term-rename-input", AutoFocus: true,
					OnSubmit: func(string) { a.saveTerminalName() },
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7,
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
						Color: colors.Text(), FontSize: 12.5}},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.termRenameOpen.Set(false) }},
				ui.Button{Text: apptext.T("保存"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "term-rename-save",
					OnPress: func() { a.saveTerminalName() }},
			},
		}
	})
}

// closeOtherTerminalTabs closes every terminal tab but one.
func (a *app) closeOtherTerminalTabs(id string) {
	for _, t := range append([]*termTab(nil), a.term.tabs.GetUntracked()...) {
		if t.ID != id {
			a.closeTerminalTab(t.ID)
		}
	}
}

// closeAllTerminalTabs closes every terminal tab.
func (a *app) closeAllTerminalTabs() {
	for _, t := range append([]*termTab(nil), a.term.tabs.GetUntracked()...) {
		a.closeTerminalTab(t.ID)
	}
}

// restartTerminal starts the tab in front again.
func (a *app) restartTerminal() {
	if tab := a.term.activeTab(); tab != nil {
		a.term.restart(tab)
	}
}

// clearTerminal empties the tab in front, scrollback included.
func (a *app) clearTerminal() {
	tab := a.term.activeTab()
	if tab == nil || tab.term == nil {
		return
	}
	tab.term.ClearScreen()
	tab.term.ClearScrollback()
}

// terminalResized remembers a height the user dragged to, once the drag
// settles.
func (a *app) terminalResized(p core.Points) {
	a.term.height.Set(float64(p))
	a.cx.AfterFunc(350*time.Millisecond, a.remember)
}

// terminalPanel is the panel under the chat.
func (a *app) terminalPanel() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{StyleFunc: func() core.Style {
			return core.Style{FlexGrow: 1, MinHeight: core.Pt(0), FlexShrink: 1, Background: colors.Background(),
				Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Line()}}
		}, Children: []core.Node{
			a.terminalHeader(cx),
			core.Show{When: a.term.findOpen.Get, Then: func(cx *core.Scope) core.Node { return a.terminalFindBar(cx) }},
			core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0)}, Children: []core.Node{a.terminalBody()}},
		}}
	})
}

// terminalHeader is the row of tabs and the panel's actions.
func (a *app) terminalHeader(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	tab := func(t *termTab) core.Node {
		on := func() bool { return a.term.active.Get() == t.ID }
		return ui.ContextMenu{Trigger: core.View{
			OnPress: func(core.PressEvent) {
				if a.term.active.Get() != t.ID {
					a.animateNextLayout()
				}
				a.term.selectTab(t.ID)
			},
			Role: core.RoleTab, LabelFunc: func() string { return t.Title.Get() }, TestID: "terminal-tab",
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(25),
					Padding: core.Edges{Left: 8, Right: 3}, CornerRadius: 6, MaxWidth: core.Pt(190), MinWidth: core.Pt(0),
					Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
					Active: &core.Style{Background: colors.Pressed()}}
				if on() {
					st.Background = colors.Surface()
					st.BorderWidth = 1
					st.BorderColor = colors.Border()
					st.Hover = &core.Style{Background: colors.Surface()}
				}
				return st
			},
			Children: []core.Node{
				ui.Icon(lucide.SquareTerminal, 11.5, colors.Muted),
				core.Text{ContentFunc: t.Title.Get, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
				core.Dynamic(func(*core.Scope) core.Node {
					switch t.state.Get() {
					case termExited:
						return ui.Text(fmt.Sprintf(apptext.T("已退出 %d"), t.exit.Get()), 9, ui.Regular, colors.Faint)
					case termFailed:
						return ui.Icon(lucide.TriangleAlert, 10, colors.Danger)
					}
					return nil
				}),
				core.View{OnPress: func(core.PressEvent) { a.closeTerminalTab(t.ID) }, Role: core.RoleButton, Label: apptext.T("关闭终端"),
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(17), Height: core.Pt(17), CornerRadius: 4, AlignItems: core.AlignCenter,
							JustifyContent: core.JustifyCenter, Transition: viewkit.PressMotion,
							Hover: &core.Style{Background: colors.Pressed()}, Active: &core.Style{Background: colors.Pressed()}}
					}, Children: []core.Node{ui.Icon(lucide.X, 10, colors.Faint)}},
			},
		}, TestID: "terminal-tab-menu", Children: []core.Node{
			ui.MenuItem{Text: apptext.T("重命名标签…"), Icon: lucide.PencilLine, OnSelect: func() { a.askTerminalName(t) }},
			ui.MenuItem{Text: apptext.T("关闭终端"), Icon: lucide.X, OnSelect: func() { a.closeTerminalTab(t.ID) }},
			ui.MenuItem{Text: apptext.T("关闭其他终端"), Icon: lucide.X, OnSelect: func() { a.closeOtherTerminalTabs(t.ID) }},
			ui.MenuItem{Text: apptext.T("关闭全部终端"), Icon: lucide.X, OnSelect: a.closeAllTerminalTabs},
		}}
	}
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(33), FlexShrink: 0,
			Padding: core.Edges{Left: 6, Right: 6, Top: 3, Bottom: 3}, Background: colors.Inset(),
			Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}
	}, Children: []core.Node{
		core.Scroll{Horizontal: true, HideIndicator: true, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)},
			Children: []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 3}, Children: []core.Node{
				core.Each(a.term.tabs.Get, func(t *termTab) string { return t.ID }, func(cx *core.Scope, t func() *termTab, _ func() int) core.Node {
					return tab(t())
				}),
			}}},
		},
		a.pressIcon(lucide.Plus, apptext.T("新建终端"), 24, 12, nil, func() { a.newTerminalTab() }, "terminal-new"),
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 1}, Children: []core.Node{
			a.pressIcon(lucide.Search, apptext.T("搜索终端"), 25, 12.5, nil, func() {
				a.term.findOpen.Set(true)
				if q := a.term.findText.GetUntracked(); q != "" {
					a.term.search(q)
				}
			}, ""),
			a.pressIcon(lucide.Eraser, apptext.T("清屏"), 25, 12.5, nil, a.clearTerminal, ""),
			a.pressIcon(lucide.RefreshCw, apptext.T("重启终端"), 25, 12.5, nil, a.restartTerminal, ""),
			a.pressIcon(lucide.X, apptext.T("隐藏终端"), 25, 13, nil, func() {
				a.term.open.Set(false)
				a.remember()
			}, "terminal-hide"),
		}},
	}}
}

// terminalFindBar searches the tab in front.
func (a *app) terminalFindBar(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	status := core.Dynamic(func(cx *core.Scope) core.Node {
		tab := a.term.activeTab()
		if tab == nil {
			return nil
		}
		st := tab.find.Get()
		if st.Text == "" {
			return nil
		}
		text := fmt.Sprintf("%d/%d", st.Selected, st.Total)
		if st.Searching {
			text = fmt.Sprintf("%d…", st.Total)
		}
		if st.Total == 0 && !st.Searching {
			text = apptext.T("无结果")
		}
		return core.Text{Content: text, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10},
			StyleFunc: ui.Colored(colors.Faint)}
	})
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(31), FlexShrink: 0,
			Padding: core.Symmetric(0, 8), Background: colors.Raised(), Borders: core.Edges{Bottom: 1},
			BorderColors: core.EdgeColors{Bottom: colors.Line()}}
	}, Children: []core.Node{
		ui.Icon(lucide.Search, 12, colors.Faint),
		core.Input{
			Value: a.term.findText.Get, OnChange: a.term.search,
			Placeholder: apptext.T("在终端里搜索"), Label: apptext.T("搜索终端"), AutoFocus: true, TestID: "terminal-search",
			Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), Height: core.Pt(24), FontSize: 12, Color: colors.Text()},
			StyleFunc: func() core.Style {
				return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
			},
		},
		status,
		a.pressIcon(lucide.ChevronUp, apptext.T("上一个匹配"), 23, 12, nil, func() { a.term.searchNext(true) }, ""),
		a.pressIcon(lucide.ChevronDown, apptext.T("下一个匹配"), 23, 12, nil, func() { a.term.searchNext(false) }, ""),
		a.pressIcon(lucide.X, apptext.T("结束搜索"), 23, 12, nil, a.term.endSearch, ""),
	}}
}

// terminalBody shows the tab in front, or what stands in for one.
func (a *app) terminalBody() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		tabs := a.term.tabs.Get()
		if len(tabs) == 0 {
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 10},
				Children: []core.Node{
					ui.Text(apptext.T("还没有终端"), 12.5, ui.Regular, colors.Muted),
					ui.Button{Text: apptext.T("新建终端"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.newTerminalTab() }},
				}}
		}
		tab := a.term.activeTab()
		if tab == nil {
			return nil
		}
		switch tab.state.Get() {
		case termStarting:
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
				Children: []core.Node{ui.Spinner{Size: 16, Label: apptext.T("启动终端")}, ui.Text(apptext.T("正在启动终端…"), 12, ui.Regular, colors.Muted)}}
		case termFailed:
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8, Padding: core.All(20)},
				Children: []core.Node{
					ui.Text(apptext.T("终端启动失败"), 13, ui.Semibold, colors.Danger),
					core.Text{Content: tab.errMsg.Get(), Style: core.Style{FontSize: 11.5, MaxWidth: core.Pt(480), TextAlign: core.TextAlignCenter},
						StyleFunc: ui.Colored(colors.Muted)},
					ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.term.restart(tab) }},
				}}
		}
		return core.Dynamic(func(cx *core.Scope) core.Node {
			tab.gen.Get()
			if tab.term == nil {
				return nil
			}
			return a.terminalView(cx, tab)
		})
	})
}

// terminalView is the grid, with the context menu an app puts on it.
func (a *app) terminalView(cx *core.Scope, tab *termTab) core.Node {
	th := terminalTheme(cx.Palette(), cx.Dark())
	view := sgt.View{
		Terminal:  tab.term,
		Font:      core.Font{Family: viewkit.MonoFont(), Size: core.Points(a.termFont.Get())},
		Theme:     th,
		DarkTheme: th,
		Padding:   sgt.Padding{X: 8, Y: 6},
		AutoFocus: true,
		TestID:    "terminal-view",
		Style:     core.Style{FlexGrow: 1, MinWidth: core.Pt(0), MinHeight: core.Pt(0)},
	}
	return ui.ContextMenu{Trigger: view, Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0)}, TestID: "terminal-menu",
		Children: []core.Node{
			ui.MenuItem{Text: apptext.T("复制"), Icon: lucide.Copy, Shortcut: "mod+c",
				Disabled: func() bool { return !tab.ref.Selected() }, OnSelect: tab.ref.Copy},
			ui.MenuItem{Text: apptext.T("粘贴"), Icon: lucide.ClipboardPaste, Shortcut: "mod+v", OnSelect: tab.ref.Paste},
			ui.MenuItem{Text: apptext.T("全选"), Icon: lucide.SquareDashed, OnSelect: tab.ref.SelectAll},
			ui.MenuItem{Text: apptext.T("清屏"), Icon: lucide.Eraser, OnSelect: a.clearTerminal},
			ui.MenuItem{Text: apptext.T("重启终端"), Icon: lucide.RefreshCw, OnSelect: a.restartTerminal},
		}}
}

// terminalTheme colors a terminal from the app's palette: the page and
// text, with danger, success, warning and accent filling the ANSI slots
// programs use most, so the shell sits in the theme instead of beside it.
func terminalTheme(p core.Palette, dark bool) *sgt.Theme {
	base := sgt.LightTheme()
	if dark {
		base = sgt.DarkTheme()
	}
	th := *base
	th.Foreground, th.Background = p.Text, p.Background
	th.Cursor, th.CursorText = p.Accent, p.Background
	th.Selection, th.SelectionText = p.Selection, p.Text
	th.Palette[1], th.Palette[9] = p.Danger, p.Danger
	th.Palette[2], th.Palette[10] = p.Success, p.Success
	th.Palette[3], th.Palette[11] = p.Warning, p.Warning
	th.Palette[4], th.Palette[12] = p.Accent, p.Accent
	th.Palette[7] = p.Text
	th.Palette[8] = p.TextMuted
	return &th
}
