package client

// The phone build: it connects to a desktop PiDeck Lite server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_LITE_MOBILE=1 for a preview on a desktop).

import (
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// findSession looks a session up in the last snapshot.
func (a *mobileApp) findSession(id string) (remotewire.Session, bool) {
	for _, p := range a.state.GetUntracked().Projects {
		for _, s := range p.Sessions {
			if s.ID == id {
				return s, true
			}
		}
	}
	return remotewire.Session{}, false
}

// sheetRow is one action in a phone sheet.
func (a *mobileApp) sheetRow(icon func() *core.SVG, label string, tone func() core.Color, press func(), testID string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleButton, Label: apptext.T(label), TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(48), Padding: core.Symmetric(0, 8),
				CornerRadius: 8, Transition: viewkit.PressMotion, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{ui.Icon(icon, 17, tone), ui.Text(apptext.T(label), 14.5, ui.Medium, tone)}}
}

// actionSheet is a session's operations: rename, pin, delete.
func (a *mobileApp) actionSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.actionID.Get() != "" },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.actionID.Set("")
			}
		},
		TestID: "mobile-actions",
		Style:  core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			id := a.actionID.Get()
			s, ok := a.findSession(id)
			if !ok {
				return nil
			}
			pinIcon, pinLabel := lucide.Pin, "置顶"
			if s.Pinned {
				pinIcon, pinLabel = lucide.PinOff, "取消置顶"
			}
			rows := []core.Node{
				core.View{Style: core.Style{Padding: core.Symmetric(4, 8), Gap: 2}, Children: []core.Node{
					core.Text{Content: s.Title, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 14, FontWeight: ui.Semibold, LineHeight: 20}, StyleFunc: ui.Colored(colors.Text)},
					ui.Text(mobileWhen(s.Updated), 10.5, ui.Regular, colors.Faint),
				}},
			}
			if a.active.Get() == id {
				rows = append(rows, a.sheetRow(lucide.PanelLeft, apptext.T("回到新建页"), colors.Text, func() {
					a.actionID.Set("")
					a.closeSession()
				}, "mobile-act-home"))
			}
			rows = append(rows,
				a.sheetRow(lucide.SquarePen, apptext.T("重命名"), colors.Text, func() {
					a.actionID.Set("")
					a.renameText.Set(s.Title)
					a.renameID.Set(id)
				}, "mobile-act-rename"),
				a.sheetRow(pinIcon, pinLabel, colors.Text, func() {
					a.actionID.Set("")
					a.setPinned(id, !s.Pinned)
				}, "mobile-act-pin"),
			)
			if s.External {
				rows = append(rows, core.Text{Content: apptext.T("pi 自己的会话只能在电脑上删除"),
					Style: core.Style{FontSize: 11, Padding: core.Symmetric(8, 8)}, StyleFunc: ui.Colored(colors.Faint)})
			} else {
				rows = append(rows, a.sheetRow(lucide.Trash, "删除会话", colors.Danger, func() {
					a.actionID.Set("")
					a.deleteID.Set(id)
				}, "mobile-act-delete"))
			}
			return core.View{Style: core.Style{Gap: 2}, Children: rows}
		})},
	}
}

// renameSheet renames the session in renameID.
func (a *mobileApp) renameSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.renameID.Get() != "" },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.renameID.Set("")
			}
		},
		Title:  apptext.T("重命名会话"),
		TestID: "mobile-rename",
		Style:  core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			return core.Input{Value: a.renameText.Get, OnChange: a.renameText.Set, Label: apptext.T("会话名字"), TestID: "mobile-rename-input",
				Placeholder: apptext.T("给这个会话起个名字"), OnSubmit: func(string) { a.saveRename() },
				Style: core.Style{Height: core.Pt(42), Padding: core.Symmetric(0, 10), FontSize: 14, Color: colors.Text(),
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 9,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}}
		})},
		Footer: []core.Node{
			ui.Button{Text: apptext.T("保存"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-rename-save", OnPress: a.saveRename},
			ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.renameID.Set("") }},
		},
	}
}

// deleteSheet confirms deleting a session from the phone.
func (a *mobileApp) deleteSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.deleteID.Get() != "" },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.deleteID.Set("")
			}
		},
		Title:       apptext.T("删除会话"),
		Description: apptext.T("会话文件会移到电脑数据目录的 trash 里，需要时可以找回。"),
		TestID:      "mobile-delete",
		Style:       core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Footer: []core.Node{
			ui.Button{Text: apptext.T("删除"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-delete-yes",
				OnPress: func() { a.deleteSession(a.deleteID.GetUntracked()) }},
			ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.deleteID.Set("") }},
		},
	}
}

// newSessionSheet picks the project the new session page starts in.
func (a *mobileApp) newSessionSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.newOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.newOpen.Set(false)
			}
		},
		Title:  apptext.T("在哪个项目里新建"),
		TestID: "mobile-new",
		Style:  core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			chosen := a.initProjectPath()
			var rows []core.Node
			for _, p := range a.state.Get().Projects {
				project := p
				on := project.Path == chosen
				row := core.View{OnPress: func(core.PressEvent) {
					a.newOpen.Set(false)
					a.initProject.Set(project.Path)
					a.saveLook()
				}, Role: core.RoleButton, Label: project.Name, TestID: "mobile-new-project",
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(46),
							Padding: core.Symmetric(0, 8), CornerRadius: 8, Transition: viewkit.PressMotion,
							Active: &core.Style{Background: colors.Pressed()}}
					},
					Children: []core.Node{
						ui.Icon(lucide.Folder, 17, colors.Muted),
						core.Text{Content: project.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FlexGrow: 1, FontSize: 14}, StyleFunc: ui.Colored(colors.Text)},
						core.Show{When: func() bool { return on }, Then: func(*core.Scope) core.Node {
							return ui.Icon(lucide.Check, 15, colors.Text)
						}},
					}}
				rows = append(rows, row)
			}
			if len(rows) == 0 {
				rows = append(rows, core.Text{Content: apptext.T("电脑上还没有项目，先添加一个文件夹。"), Style: core.Style{FontSize: 12, Padding: core.Symmetric(8, 6)},
					StyleFunc: ui.Colored(colors.Faint)})
			}
			rows = append(rows, core.View{Style: core.Style{Margin: core.Edges{Top: 6}}, Children: []core.Node{
				a.sheetRow(lucide.FolderPlus, "添加项目…", colors.Accent, func() {
					a.newOpen.Set(false)
					a.addPath.Set("")
					a.addOpen.Set(true)
				}, "mobile-add-project"),
			}})
			return core.View{Style: core.Style{Gap: 2}, Children: rows}
		})},
	}
}

// addProjectSheet asks for a folder to put on the desktop's rail.
func (a *mobileApp) addProjectSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.addOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.addOpen.Set(false)
			}
		},
		Title:       apptext.T("添加项目"),
		Description: apptext.T("填电脑上的文件夹路径，和电脑端「添加工作区」是同一件事。"),
		TestID:      "mobile-add-project-sheet",
		Style:       core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			return core.Input{Value: a.addPath.Get, OnChange: a.addPath.Set, Label: apptext.T("文件夹路径"), TestID: "mobile-add-path",
				Placeholder: apptext.T("例如 C:/Users/me/project"), OnSubmit: func(string) { a.addProject() },
				Style: core.Style{Height: core.Pt(42), Padding: core.Symmetric(0, 10), FontSize: 13.5, Color: colors.Text(),
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 9,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}}
		})},
		Footer: []core.Node{
			ui.Button{Text: apptext.T("添加"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-add-yes", OnPress: a.addProject},
			ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.addOpen.Set(false) }},
		},
	}
}

// removeProjectSheet confirms taking a project off the desktop's rail.
func (a *mobileApp) removeProjectSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.removePath.Get() != "" },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.removePath.Set("")
			}
		},
		Title:       apptext.T("移除项目"),
		Description: apptext.T("只是从电脑端的侧栏移除，会话文件和项目目录都还在。"),
		TestID:      "mobile-remove-project-sheet",
		Footer: []core.Node{
			ui.Button{Text: apptext.T("移除"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-remove-yes",
				OnPress: func() { a.changeProject(a.removePath.GetUntracked(), true) }},
			ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.removePath.Set("") }},
		},
	}
}

// addProject applies the add sheet.
func (a *mobileApp) addProject() {
	path := strings.TrimSpace(a.addPath.GetUntracked())
	if path == "" {
		return
	}
	a.addOpen.Set(false)
	a.changeProject(path, false)
}

// changeProject adds or removes a folder on the desktop.
func (a *mobileApp) changeProject(path string, remove bool) {
	client := a.client
	if client == nil || path == "" {
		return
	}
	a.removePath.Set("")
	go func() {
		err := client.addProject(path, remove)
		a.cx.Post(func() {
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			a.err.Set("")
			if remove {
				a.flash("已移除项目")
			} else {
				a.flash("已添加项目")
			}
			a.refreshState()
		})
	}()
}

// startNewSession goes back to the new-session page, which is where a
// session starts: pick a project, write the first line.
func (a *mobileApp) startNewSession() {
	a.openDrawer(false)
	a.closeSession()
}

// saveRename applies the rename sheet.
func (a *mobileApp) saveRename() {
	id := a.renameID.GetUntracked()
	name := strings.TrimSpace(a.renameText.GetUntracked())
	client := a.client
	if id == "" || name == "" || client == nil {
		return
	}
	a.renameID.Set("")
	go func() {
		err := client.rename(id, name)
		a.cx.Post(func() {
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			a.err.Set("")
			if a.active.GetUntracked() == id {
				a.activeTitle.Set(name)
			}
			a.refreshState()
		})
	}()
}

// setPinned pins or unpins a session.
func (a *mobileApp) setPinned(id string, pinned bool) {
	client := a.client
	if client == nil || id == "" {
		return
	}
	go func() {
		err := client.pin(id, pinned)
		a.cx.Post(func() {
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			a.err.Set("")
			a.refreshState()
		})
	}()
}

// deleteSession removes a session and returns to the list.
func (a *mobileApp) deleteSession(id string) {
	client := a.client
	if client == nil || id == "" {
		return
	}
	a.deleteID.Set("")
	go func() {
		err := client.deleteSession(id)
		a.cx.Post(func() {
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			a.err.Set("")
			if a.active.GetUntracked() == id {
				a.closeSession()
			}
			a.refreshState()
		})
	}()
}
