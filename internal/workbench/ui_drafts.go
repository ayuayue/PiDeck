//go:build !js && !android && !ios

package workbench

import (
	"slices"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) draftsPane() core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		items := core.NewMemoFunc(cx, func() []savedDraft {
			project, query := a.draftProject(), strings.ToLower(strings.TrimSpace(a.drafts.query.Get()))
			return slices.DeleteFunc(slices.Clone(a.drafts.items.Get()), func(d savedDraft) bool {
				return (d.Project != "" && d.Project != project) || !strings.Contains(strings.ToLower(d.Title+"\n"+d.Text), query)
			})
		}, slices.Equal)
		return core.View{Style: ui.FillRest, Children: []core.Node{
			a.paneHeader("草稿本", "保留项目草稿和常用消息。", ui.Button{Text: apptext.T("新建草稿"), TestID: "drafts-new",
				Disabled: a.drafts.busy.Get, OnPress: func() { a.drafts.edit.Set(savedDraft{ID: newSessionID(), Project: a.draftProject()}) }}),
			core.Show{When: func() bool { return a.drafts.edit.Get().ID != "" },
				Then: func(cx *core.Scope) core.Node { return a.draftEditor(cx) },
				Else: func(cx *core.Scope) core.Node {
					return core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), Padding: core.Symmetric(12, 12), Gap: 8}, Children: []core.Node{
						core.Input{Value: a.drafts.query.Get, OnChange: a.drafts.query.Set, Placeholder: apptext.T("搜索草稿"),
							Label: apptext.T("搜索草稿"), TestID: "drafts-search", Style: draftFieldStyle(colors)},
						core.List{Style: ui.FillRest, EstimatedSize: 48, Count: func() int { return len(items.Get()) },
							Key:   func(i int) any { return items.Get()[i].ID },
							Empty: ui.Text(apptext.T("没有草稿"), 12, ui.Regular, colors.Muted),
							Row: func(cx *core.Scope, row core.ListRow) core.Node {
								return core.Dynamic(func(cx *core.Scope) core.Node {
									list, i := items.Get(), row.Index()
									if i < 0 || i >= len(list) {
										return nil
									}
									return a.draftRow(cx, list[i])
								})
							}},
					}}
				}},
		}}
	})
}

func draftFieldStyle(colors ui.Colors) core.Style {
	return core.Style{MinHeight: core.Pt(34), Padding: core.Symmetric(6, 10), CornerRadius: ui.RadiusControl,
		Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), FontSize: 13}
}

func (a *app) draftEditor(cx *core.Scope) core.Node {
	draft := a.drafts.edit
	field := draftFieldStyle(ui.ColorsOf(cx))
	bodyStyle := field
	bodyStyle.MinHeight, bodyStyle.FlexGrow, bodyStyle.TextAlignVertical = core.Pt(115), 1, core.TextAlignVerticalTop
	project := a.draftProject()
	return core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), Padding: core.Symmetric(12, 12), Gap: 10}, Children: []core.Node{
		core.Input{Value: func() string { return draft.Get().Title }, OnChange: func(text string) {
			draft.Update(func(d savedDraft) savedDraft { d.Title = text; return d })
		}, Label: apptext.T("标题"), Placeholder: apptext.T("标题"), TestID: "draft-title", Style: field},
		core.Input{Value: func() string { return draft.Get().Text }, OnChange: func(text string) {
			draft.Update(func(d savedDraft) savedDraft { d.Text = text; return d })
		}, Multiline: true, Label: apptext.T("草稿正文"), Placeholder: apptext.T("草稿正文"), TestID: "draft-body", Style: bodyStyle},
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
			ui.ToggleButton{Text: apptext.T("仅当前项目"), TestID: "draft-project", Disabled: func() bool { return project == "" },
				On: func() bool { return draft.Get().Project != "" }, OnChange: func(on bool) {
					draft.Update(func(d savedDraft) savedDraft {
						d.Project = ""
						if on {
							d.Project = project
						}
						return d
					})
				}},
			ui.ToggleButton{Text: apptext.T("快捷消息"), TestID: "draft-quick", On: func() bool { return draft.Get().Quick }, OnChange: func(on bool) {
				draft.Update(func(d savedDraft) savedDraft { d.Quick = on; return d })
			}},
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Button{Text: apptext.T("取消"), TestID: "draft-cancel", Variant: ui.ButtonGhost, Disabled: a.drafts.busy.Get,
				OnPress: func() { draft.Set(savedDraft{}) }},
			ui.Button{Text: apptext.T("保存"), TestID: "draft-save", Disabled: func() bool { return a.drafts.busy.Get() || !draft.Get().valid() }, OnPress: a.saveDraftEntry},
		}},
	}}
}

func (a *app) draftRow(cx *core.Scope, d savedDraft) core.Node {
	icon := lucide.FileText
	if d.Quick {
		icon = lucide.Zap
	}
	item := composerRow(cx, icon, d.Title, viewkit.FirstLine(d.Text, 100), false, false, func() { a.insertDraftEntry(d) })
	item.Style.FlexGrow = 1
	item.Style.MinWidth = core.Pt(0)
	item.TestID = "draft-use-" + d.ID
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Padding: core.Symmetric(3, 0)}, Children: []core.Node{
		item,
		ui.IconButton{Icon: lucide.Pencil, Label: apptext.T("编辑"), TestID: "draft-edit-" + d.ID, Disabled: a.drafts.busy.Get,
			OnPress: func() { a.drafts.edit.Set(d) }},
		ui.IconButton{Icon: lucide.Trash, Label: apptext.T("删除"), TestID: "draft-delete-" + d.ID, Disabled: a.drafts.busy.Get, OnPress: func() {
			a.askConfirm("删除草稿", d.Title, "删除", func() {
				next := slices.DeleteFunc(slices.Clone(a.drafts.items.GetUntracked()), func(item savedDraft) bool { return item.ID == d.ID })
				a.persistDraftLibrary(next, nil)
			})
		}},
	}}
}

func (a *app) composerDraftItems(cx *core.Scope, s *session) []core.Node {
	project := s.Target.key() + "|" + s.WS
	rows := []core.Node{composerRow(cx, lucide.BookOpen, apptext.T("草稿本"), apptext.T("保存当前草稿"), false, false, func() {
		s.modeOpen.Set(false)
		a.openDrafts(strings.TrimSpace(s.draft.GetUntracked()) != "")
	})}
	var quick []core.Node
	for _, d := range a.drafts.items.Get() {
		if !d.Quick || (d.Project != "" && d.Project != project) {
			continue
		}
		quick = append(quick, composerRow(cx, lucide.Zap, d.Title, viewkit.FirstLine(d.Text, 72), false, false, func() {
			s.modeOpen.Set(false)
			a.insertDraftEntry(d)
		}))
	}
	if len(quick) != 0 {
		rows = append(rows, composerPanelTitle(cx, apptext.T("快捷消息")),
			core.Scroll{Style: core.Style{MaxHeight: core.Pt(150)}, Children: []core.Node{core.View{Children: quick}}})
	}
	return rows
}
