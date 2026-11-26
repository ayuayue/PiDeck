//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// sessionRunMenuItems shares lifecycle actions across the toolbar, tabs and rail.
func (a *app) sessionRunMenuItems(sess func() *session) []core.Node {
	return []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
		s := sess()
		if s == nil {
			return nil
		}
		label, icon := "启动 Agent", lucide.Play
		if s.hasAgent() {
			label, icon = "重启 Agent", lucide.RefreshCw
		}
		primary := a.menuRow(cx, icon, label, "", false, func() { a.askRestartAgent(sess()) })
		primary.Disabled = func() bool { return !sess().canControlAgent() }
		stop := a.menuRow(cx, lucide.Square, "停止当前运行", "", false, func() { a.stop(sess()) })
		stop.Disabled = func() bool { return !sess().canControlAgent() || !sess().busy() }
		reload := a.menuRow(cx, lucide.ListRestart, "重新读取会话", "", false, func() { a.reloadSession(sess()) })
		reload.Disabled = func() bool { return !sess().canReloadSession() }
		close := a.menuRow(cx, lucide.Power, "关闭 Agent", "", false, func() { a.askCloseAgent(sess()) })
		close.Disabled = func() bool { return !sess().canControlAgent() || !sess().hasAgent() }
		return core.View{Children: []core.Node{primary, stop, reload, close}}
	})}
}

// sessionToolbar stays outside the scrolling tabs so actions remain reachable.
func (a *app) sessionToolbar() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		s := a.active()
		if s == nil || (a.paneVisible() && !a.filePaneVisible()) {
			return nil
		}
		return core.View{TestID: "session-toolbar", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2, FlexShrink: 0}, Children: []core.Node{
			core.Dynamic(func(cx *core.Scope) core.Node {
				label, icon := "启动 Agent", lucide.Play
				if s.hasAgent() {
					label, icon = "重启 Agent", lucide.RefreshCw
				}
				if s.agentStopping {
					label = "正在关闭 Agent…"
					if s.restarting {
						label = "正在重启 Agent…"
					}
				}
				return hint(label, ui.IconButton{Icon: icon, Label: apptext.T(label), TestID: "session-agent-toggle", Size: 28, IconSize: 14,
					Disabled: func() bool { return !s.canControlAgent() }, OnPress: func() { a.askRestartAgent(s) }})
			}),
			hint("重新读取会话", ui.IconButton{Icon: lucide.ListRestart, Label: apptext.T("重新读取会话"), TestID: "session-reload", Size: 28, IconSize: 14,
				Disabled: func() bool { return !s.canReloadSession() }, OnPress: func() { a.reloadSession(s) }}),
			ui.Menu{Placement: core.PlaceBottom, Align: core.AlignEnd, TestID: "session-actions",
				Trigger: ui.Button{Icon: lucide.Ellipsis, Label: apptext.T("更多会话操作"), Variant: ui.ButtonGhost, Side: 28, IconSize: 14},
				Children: append(a.sessionRunMenuItems(func() *session { return s }),
					a.menuSeparator(cx),
					a.menuRow(cx, lucide.Pencil, "重命名", "", false, func() { a.askRename(s) }),
					a.menuRow(cx, lucide.FileDown, "导出…", "", false, func() { a.openExport(s) }),
					a.menuSeparator(cx),
					a.menuRow(cx, lucide.X, "关闭标签页", "", false, func() { a.closeTab(s.ID) })),
			},
		}}
	})
}
