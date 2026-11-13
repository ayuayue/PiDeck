package main

// The terminal panel and the actions its header, menus and the palette
// call.

import (
	"fmt"
	"time"

	sgt "github.com/oneo-me/nsgo/base/terminal"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
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
		return core.View{
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
					Transition: pressMotion, Hover: &core.Style{Background: colors.Hover()},
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
						return ui.Text(fmt.Sprintf(T("已退出 %d"), t.exit.Get()), 9, ui.Regular, colors.Faint)
					case termFailed:
						return ui.Icon(lucide.TriangleAlert, 10, colors.Danger)
					}
					return nil
				}),
				core.View{OnPress: func(core.PressEvent) { a.closeTerminalTab(t.ID) }, Role: core.RoleButton, Label: T("关闭终端"),
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(17), Height: core.Pt(17), CornerRadius: 4, AlignItems: core.AlignCenter,
							JustifyContent: core.JustifyCenter, Transition: pressMotion,
							Hover: &core.Style{Background: colors.Pressed()}, Active: &core.Style{Background: colors.Pressed()}}
					}, Children: []core.Node{ui.Icon(lucide.X, 10, colors.Faint)}},
			},
		}
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
		a.pressIcon(lucide.Plus, T("新建终端"), 24, 12, nil, func() { a.newTerminalTab() }, "terminal-new"),
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 1}, Children: []core.Node{
			a.pressIcon(lucide.Search, T("搜索终端"), 25, 12.5, nil, func() {
				a.term.findOpen.Set(true)
				if q := a.term.findText.GetUntracked(); q != "" {
					a.term.search(q)
				}
			}, ""),
			a.pressIcon(lucide.Eraser, T("清屏"), 25, 12.5, nil, a.clearTerminal, ""),
			a.pressIcon(lucide.RefreshCw, T("重启终端"), 25, 12.5, nil, a.restartTerminal, ""),
			a.pressIcon(lucide.X, T("隐藏终端"), 25, 13, nil, func() {
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
			text = T("无结果")
		}
		return core.Text{Content: text, Style: core.Style{FontFamily: ui.Mono, FontSize: 10},
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
			Placeholder: T("在终端里搜索"), Label: T("搜索终端"), AutoFocus: true, TestID: "terminal-search",
			Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), Height: core.Pt(24), FontSize: 12, Color: colors.Text()},
			StyleFunc: func() core.Style {
				return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
			},
		},
		status,
		a.pressIcon(lucide.ChevronUp, T("上一个匹配"), 23, 12, nil, func() { a.term.searchNext(true) }, ""),
		a.pressIcon(lucide.ChevronDown, T("下一个匹配"), 23, 12, nil, func() { a.term.searchNext(false) }, ""),
		a.pressIcon(lucide.X, T("结束搜索"), 23, 12, nil, a.term.endSearch, ""),
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
					ui.Text(T("还没有终端"), 12.5, ui.Regular, colors.Muted),
					ui.Button{Text: T("新建终端"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.newTerminalTab() }},
				}}
		}
		tab := a.term.activeTab()
		if tab == nil {
			return nil
		}
		switch tab.state.Get() {
		case termStarting:
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
				Children: []core.Node{ui.Spinner{Size: 16, Label: "启动终端"}, ui.Text(T("正在启动终端…"), 12, ui.Regular, colors.Muted)}}
		case termFailed:
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8, Padding: core.All(20)},
				Children: []core.Node{
					ui.Text(T("终端启动失败"), 13, ui.Semibold, colors.Danger),
					core.Text{Content: tab.errMsg.Get(), Style: core.Style{FontSize: 11.5, MaxWidth: core.Pt(480), TextAlign: core.TextAlignCenter},
						StyleFunc: ui.Colored(colors.Muted)},
					ui.Button{Text: "重试", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.term.restart(tab) }},
				}}
		}
		return core.Dynamic(func(cx *core.Scope) core.Node {
			tab.gen.Get()
			if tab.term == nil {
				return nil
			}
			return a.terminalView(tab)
		})
	})
}

// terminalView is the grid, with the context menu an app puts on it.
func (a *app) terminalView(tab *termTab) core.Node {
	view := sgt.View{
		Terminal:  tab.term,
		Font:      core.Font{Size: 12.5},
		Padding:   sgt.Padding{X: 8, Y: 6},
		AutoFocus: true,
		TestID:    "terminal-view",
		Style:     core.Style{FlexGrow: 1, MinWidth: core.Pt(0), MinHeight: core.Pt(0)},
	}
	return ui.ContextMenu{Trigger: view, Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0)}, TestID: "terminal-menu",
		Children: []core.Node{
			ui.MenuItem{Text: T("复制"), Icon: lucide.Copy, Shortcut: "mod+c",
				Disabled: func() bool { return !tab.ref.Selected() }, OnSelect: tab.ref.Copy},
			ui.MenuItem{Text: T("粘贴"), Icon: lucide.ClipboardPaste, Shortcut: "mod+v", OnSelect: tab.ref.Paste},
			ui.MenuItem{Text: T("全选"), Icon: lucide.SquareDashed, OnSelect: tab.ref.SelectAll},
			ui.MenuItem{Text: T("清屏"), Icon: lucide.Eraser, OnSelect: a.clearTerminal},
			ui.MenuItem{Text: T("重启终端"), Icon: lucide.RefreshCw, OnSelect: a.restartTerminal},
		}}
}
