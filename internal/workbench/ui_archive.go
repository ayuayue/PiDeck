//go:build !js && !android && !ios

package workbench

// The archived sessions dialog: what the rail hides, with ways back.

import (
	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// archiveDialogOpen shows the dialog.
func (a *app) openArchiveDialog() {
	a.archiveOpen.Set(true)
}

// unarchiveByID takes a session out of the archived list.
func (a *app) unarchiveByID(id string) {
	if !a.sessionArchived(id) {
		return
	}
	next := make([]string, 0, len(a.cfg.Archived))
	for _, x := range a.cfg.Archived {
		if x != id {
			next = append(next, x)
		}
	}
	a.cfg.Archived = next
	if a.st != nil {
		a.st.edit(func(c *config) { c.Archived = append([]string(nil), next...) })
	}
	a.archiveRev.Update(func(n int) int { return n + 1 })
}

// openArchived opens an archived session in the chat.
func (a *app) openArchived(id string) {
	s := a.findSession(id)
	if s == nil {
		a.toast(ui.ToastWarning, apptext.T("找不到这个会话"), apptext.T("会话文件可能已经被删除。"))
		return
	}
	a.archiveOpen.Set(false)
	a.selectSession(s)
}

// archiveDialog lists what the rail hides.
func (a *app) archiveDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.archiveRev.Get()
		_ = a.langRev.Get()
		var rows []core.Node
		for _, id := range a.cfg.Archived {
			id := id
			name := a.sessionTitle(id)
			where := ""
			if s := a.findSession(id); s != nil {
				where = projectLabel(s.WS)
			}
			rows = append(rows, core.View{TestID: "archived-row",
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(34),
					Padding: core.Symmetric(2, 6)},
				Children: []core.Node{
					ui.Icon(lucide.Archive, 12, colors.Faint),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
						core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
						core.Show{When: func() bool { return where != "" }, Then: func(*core.Scope) core.Node {
							return core.Text{Content: where, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
						}},
					}},
					ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "archived-open",
						OnPress: func() { a.openArchived(id) }},
					ui.Button{Text: apptext.T("取消归档"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "archived-unarchive",
						OnPress: func() { a.unarchiveByID(id) }},
				}})
		}
		var body core.Node
		if len(rows) == 0 {
			body = core.Text{Content: apptext.T("还没有归档的会话。"), Style: core.Style{FontSize: 11, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)}
		} else {
			body = core.Scroll{Style: core.Style{MaxHeight: core.Pt(380)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 2}, Children: rows}}}
		}
		return ui.Dialog{
			Open:         a.archiveOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.archiveOpen.Set(open) },
			Title:        apptext.T("已归档的会话"),
			Description:  apptext.T("这些会话不在侧栏里，文件仍在磁盘上。"),
			TestID:       "archive-dialog",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(520)},
			Children:     []core.Node{body},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.archiveOpen.Set(false) }},
			},
		}
	})
}
