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

// tabBar is the open sessions, above the chat, and the split panes' tabs
// at its end.
//
// The strip is the window's handle: the tabs scroll when they outgrow it,
// and the run after them drags the window, as a title bar's empty part does.
// A scroll view takes the pointer, so a strip that only scrolled could never
// move the window.
func (a *app) tabBar() core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
		core.Scroll{Horizontal: true, HideIndicator: true, TestID: "tab-bar", Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Padding: core.Symmetric(0, 2)}, Children: []core.Node{
				core.Each(a.tabs.Get, func(id string) string { return id }, func(cx *core.Scope, id func() string, _ func() int) core.Node {
					return a.tab(id)
				}),
				hint("新建会话", ui.IconButton{Icon: lucide.Plus, Label: apptext.T("新建会话"), Size: 26, IconSize: 13, OnPress: func() {
					a.newSession(a.activeWS.Get())
				}}),
				// A line keeps the panes' tabs apart from the sessions'.
				core.Show{When: func() bool { return len(a.openPaneIDs()) > 0 }, Then: func(cx *core.Scope) core.Node {
					return core.View{Style: core.Style{Width: core.Pt(1), Height: core.Pt(16), FlexShrink: 0, Margin: core.Symmetric(0, 3)},
						StyleFunc: ui.Filled(ui.ColorsOf(cx).Line)}
				}},
				core.Each(a.openPaneIDs, func(id string) string { return id }, func(cx *core.Scope, id func() string, _ func() int) core.Node {
					def, ok := a.pane(id())
					if !ok {
						return nil
					}
					return a.paneTab(def)
				}),
			}},
		}},
		core.View{TestID: "tab-bar-drag", Desktop: core.DesktopViewProps{WindowDrag: core.WindowDragOn},
			Style: core.Style{FlexGrow: 1, FlexShrink: 1, Height: core.Pct(100), MinWidth: core.Pt(0)}},
	}}
}

// tab is one open session.
func (a *app) tab(id func() string) core.Node {
	colors := ui.ColorsOf(a.cx)
	sess := func() *session { return a.byID[id()] }
	active := func() bool { return a.activeID.Get() == id() && !a.paneVisible() }
	return base.ContextMenu{
		Trigger: core.View{
			TestID: "tab",
			Ref:    a.tabRef(id()),
			OnPress: func(core.PressEvent) {
				if s := sess(); s != nil {
					a.selectSession(s)
				}
			},
			Role: core.RoleButton, LabelFunc: func() string { return sess().title.Get() },
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(28), MaxWidth: core.Pt(220),
					Padding: core.Edges{Left: 9, Right: 5}, CornerRadius: 7, BorderWidth: 1, BorderColor: core.Transparent,
					Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				if active() {
					st.Background = colors.Surface()
					st.BorderColor = colors.Border()
					st.Hover = &core.Style{Background: colors.Surface()}
				}
				return st
			},
			Children: []core.Node{
				core.View{TestID: "tab-status-" + id(), StyleFunc: func() core.Style {
					return core.Style{Width: core.Pt(5), Height: core.Pt(5), CornerRadius: 3,
						Background: statusDot(colors, sess()), FlexShrink: 0}
				}},
				core.Text{ContentFunc: func() string { return sess().title.Get() }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
				core.View{OnPress: func(core.PressEvent) { a.closeTab(id()) }, Role: core.RoleButton, Label: apptext.T("关闭标签页"),
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(18), Height: core.Pt(18), CornerRadius: 5, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
							Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Pressed()}, Active: &core.Style{Background: colors.Pressed()}}
					}, Children: []core.Node{ui.Icon(lucide.X, 11, colors.Faint)}},
			},
		},
		Children:   a.tabMenuItems(id),
		PopupStyle: core.Style{MinWidth: core.Pt(180)},
		PopupStyleFunc: func() core.Style {
			return a.menuCard(a.cx)
		},
	}
}

// tabMenuItems is a tab's right-click menu.
func (a *app) tabMenuItems(id func() string) []core.Node {
	return []core.Node{
		a.menuRow(a.cx, lucide.X, "关闭标签页", "", false, func() { a.closeTab(id()) }),
		a.menuRow(a.cx, lucide.X, "关闭其他标签", "", false, func() { a.closeOtherTabs(id()) }),
		a.menuRow(a.cx, lucide.X, "关闭右侧标签", "", false, func() { a.closeTabsRight(id()) }),
		a.menuRow(a.cx, lucide.X, "关闭全部标签", "", false, func() { a.closeAllTabs() }),
		a.menuSeparator(a.cx),
		a.menuRow(a.cx, lucide.Pencil, "重命名", "", false, func() { a.askRename(a.byID[id()]) }),
		a.menuRow(a.cx, lucide.CopyPlus, "复制会话", "", false, func() { a.duplicateSession(a.byID[id()]) }),
		a.menuRow(a.cx, lucide.FileDown, "导出…", "", false, func() { a.openExport(a.byID[id()]) }),
		a.menuRow(a.cx, lucide.Copy, "复制会话 ID", "", false, func() { a.copyText(id(), "会话 ID") }),
	}
}
