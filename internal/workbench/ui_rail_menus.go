//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// Column tabs and their header buttons share actions and grouping, so a
// right-click works even when that column is not currently visible.
func (a *app) railTabMenuItems(id string) []core.Node {
	switch id {
	case railTabProjects:
		return a.projectHeaderMenuItems()
	case railTabChat:
		return a.chatHeaderMenuItems()
	default:
		return []core.Node{
			a.menuRow(a.cx, lucide.SquarePen, "新建会话", "", false, a.railNewSession),
			a.menuRow(a.cx, lucide.RefreshCw, "刷新所有项目", "", false, a.refreshAllProjects),
			a.menuSeparator(a.cx),
			a.menuRow(a.cx, lucide.ListChecks, "会话管理…", "", false, func() { a.openSessionManager(nil, false) }),
		}
	}
}

func (a *app) projectHeaderMenuItems() []core.Node {
	return []core.Node{
		ui.MenuLabel{Text: apptext.T("列表视图")},
		a.menuRow(a.cx, lucide.RefreshCw, "刷新所有项目", "", false, a.refreshAllProjects),
		a.menuRow(a.cx, lucide.ChevronsDown, "全部展开", "", false, func() { a.setAllProjectsExpanded(true) }),
		a.menuRow(a.cx, lucide.ChevronsUp, "全部收起", "", false, func() { a.setAllProjectsExpanded(false) }),
		a.projectSortMenu(),
		a.sessionSortMenu(),
		a.menuSeparator(a.cx),
		ui.MenuLabel{Text: apptext.T("会话管理")},
		a.menuRow(a.cx, lucide.ListChecks, "会话管理…", "", false, func() { a.openSessionManager(nil, false) }),
		a.menuRow(a.cx, lucide.Archive, "已归档…", "", false, a.openArchiveDialog),
		a.menuRow(a.cx, lucide.Archive, showArchivedLabel(a), "", false, a.toggleShowArchived),
		a.menuSeparator(a.cx),
		a.menuRow(a.cx, lucide.FolderMinus, "选择要移除的项目…", "", false, func() { a.projectRemoveOpen.Set(true) }),
		a.menuRow(a.cx, lucide.FolderMinus, "移除所有项目…", "", true, a.removeAllProjects),
	}
}

func (a *app) chatHeaderMenuItems() []core.Node {
	return []core.Node{
		a.menuRow(a.cx, lucide.MessageCirclePlus, "新对话", "", false, func() { a.openChat() }),
		a.menuRow(a.cx, lucide.RefreshCw, "刷新对话", "", false, a.refreshChats),
		a.menuSeparator(a.cx),
		ui.MenuLabel{Text: apptext.T("会话管理")},
		a.menuRow(a.cx, lucide.ListChecks, "会话管理…", "", false, func() { a.openChatSessionManager(false) }),
		a.menuRow(a.cx, lucide.Archive, "已归档…", "", false, func() { a.openChatSessionManager(true) }),
		a.menuSeparator(a.cx),
		ui.MenuLabel{Text: apptext.T("列表视图")},
		a.sessionSortMenu(),
		a.menuRow(a.cx, lucide.Archive, showArchivedLabel(a), "", false, a.toggleShowArchived),
		a.menuSeparator(a.cx),
		a.menuRow(a.cx, lucide.FolderOpen, "在文件管理器中打开", "", false, func() { a.revealProject(a.chatWorkspace()) }),
	}
}
