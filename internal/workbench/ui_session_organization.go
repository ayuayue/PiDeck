//go:build !js && !android && !ios

package workbench

import (
	"maps"
	"slices"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

type sessionOrganizationDialog struct {
	kind     string
	id, path string
	ws       *workspace
}

func (a *app) openSessionGroup(s *session) {
	if s == nil {
		return
	}
	a.organizationInput.Set(a.organization.GetUntracked().Groups[s.ID])
	a.organizationDialog.Set(sessionOrganizationDialog{kind: "move", id: s.ID, ws: a.workspaceFor(s.Target, s.WS)})
}

func (a *app) openSessionLink(s *session) {
	if s == nil {
		return
	}
	a.organizationInput.Set("")
	a.organizationDialog.Set(sessionOrganizationDialog{kind: "link", id: s.ID, ws: a.workspaceFor(s.Target, s.WS)})
}

func (a *app) closeSessionOrganizationDialog() {
	a.organizationDialog.Set(sessionOrganizationDialog{})
}

func (a *app) newLinkedSession(parent *session) {
	ws := a.workspaceFor(parent.Target, parent.WS)
	if ws == nil {
		return
	}
	preset := a.acpPresetByID(parent.acpPreset)
	var child *session
	if parent.backend == "acp" && preset != nil {
		child = a.newACPSession(ws, *preset)
	} else {
		child = a.newProjectSession(ws)
	}
	if child != nil {
		a.linkSession(child, parent)
	}
}

func (a *app) sessionOrganizationPanel() core.Node {
	return core.Show{When: func() bool { return a.organizationDialog.Get().kind != "" }, Then: func(cx *core.Scope) core.Node {
		return core.Dynamic(func(cx *core.Scope) core.Node {
			state := a.organizationDialog.Get()
			if state.kind == "link" {
				return a.sessionLinkPanel(cx, state)
			}
			return a.sessionGroupPanel(cx, state)
		})
	}}
}

func (a *app) sessionGroupPanel(cx *core.Scope, state sessionOrganizationDialog) core.Node {
	colors := ui.ColorsOf(cx)
	title := apptext.T("移动会话到分组")
	if state.kind == "rename" {
		title = apptext.T("编辑会话分组")
	}
	invalid := func() bool {
		input := strings.TrimSpace(a.organizationInput.Get())
		return input != "" && sessionGroupPath(input) == ""
	}
	save := func() {
		if invalid() {
			return
		}
		path := sessionGroupPath(a.organizationInput.GetUntracked())
		if state.kind == "rename" && state.ws != nil {
			a.changeGroupPath(state.ws, state.path, path)
		} else if state.id != "" {
			a.setSessionGroup(state.id, path)
		}
		a.closeSessionOrganizationDialog()
	}
	return ui.Dialog{Open: func() bool { return a.organizationDialog.Get().kind != "" },
		OnOpenChange: func(on bool, _ base.Reason) {
			if !on {
				a.closeSessionOrganizationDialog()
			}
		},
		Title: title, TestID: "session-group-dialog", Style: core.Style{Width: a.dialogWidth()},
		Children: []core.Node{
			core.Input{Value: a.organizationInput.Get, OnChange: a.organizationInput.Set, OnSubmit: func(string) { save() },
				Placeholder: apptext.T("分组名"), Label: apptext.T("分组名"), TestID: "session-group-input", AutoFocus: true,
				Style: core.Style{Height: core.Pt(34), Padding: core.Symmetric(0, 9), CornerRadius: ui.RadiusControl,
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text()}},
			ui.Text(apptext.T("用 / 分隔子分组，最多四层。留空移出分组。"), 11.5, ui.Regular, colors.Muted),
			a.sessionGroupSuggestions(cx, state.ws),
		}, Footer: []core.Node{
			ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, OnPress: a.closeSessionOrganizationDialog},
			ui.Button{Text: apptext.T("保存"), TestID: "session-group-save", Disabled: invalid, OnPress: save},
		}}
}

func (a *app) sessionGroupSuggestions(cx *core.Scope, ws *workspace) core.Node {
	if ws == nil {
		return nil
	}
	groups := a.organization.Get().Groups
	seen := make(map[string]bool)
	var paths []string
	for _, sessions := range [][]*session{ws.Sessions.Get(), ws.Pi.Get()} {
		for _, s := range sessions {
			if path := groups[s.ID]; path != "" && !seen[path] {
				seen[path] = true
				paths = append(paths, path)
			}
		}
	}
	slices.Sort(paths)
	var chips []core.Node
	for _, path := range paths[:min(24, len(paths))] {
		chips = append(chips, ui.ToggleButton{Text: path, Label: path, On: func() bool { return a.organizationInput.Get() == path },
			OnChange: func(on bool) {
				if on {
					a.organizationInput.Set(path)
				}
			}})
	}
	return core.Scroll{Style: core.Style{MaxHeight: core.Pt(110)}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 4, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: chips},
	}}
}

func (a *app) sessionLinkPanel(cx *core.Scope, state sessionOrganizationDialog) core.Node {
	colors := ui.ColorsOf(cx)
	org := a.organization.Get()
	child := a.findSession(state.id)
	var candidates []*session
	if ws := state.ws; ws != nil {
		seen := make(map[string]bool)
		for _, list := range [][]*session{ws.Sessions.Get(), ws.Pi.Get()} {
			for _, s := range list {
				if !seen[s.ID] && org.canLink(state.id, s.ID) {
					seen[s.ID] = true
					candidates = append(candidates, s)
				}
			}
		}
	}
	footer := []core.Node{ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, OnPress: a.closeSessionOrganizationDialog}}
	if org.Links[state.id].Parent != "" {
		footer = append(footer, ui.Button{Text: apptext.T("解除父子关联"), TestID: "session-link-clear", Variant: ui.ButtonSecondary, OnPress: func() {
			a.changeSessionOrganization(func(org *sessionOrganization) { delete(org.Links, state.id) })
			a.closeSessionOrganizationDialog()
		}})
	}
	filtered := core.NewMemoFunc(cx, func() []*session {
		query := strings.ToLower(strings.TrimSpace(a.organizationInput.Get()))
		return slices.DeleteFunc(slices.Clone(candidates), func(s *session) bool { return !strings.Contains(strings.ToLower(s.title.Get()), query) })
	}, slices.Equal)
	return ui.Dialog{Open: func() bool { return a.organizationDialog.Get().kind != "" },
		OnOpenChange: func(on bool, _ base.Reason) {
			if !on {
				a.closeSessionOrganizationDialog()
			}
		},
		Title: apptext.T("选择父会话"), TestID: "session-link-dialog", Style: core.Style{Width: a.dialogWidth()},
		Children: []core.Node{
			core.Input{Value: a.organizationInput.Get, OnChange: a.organizationInput.Set, AutoFocus: true,
				Placeholder: apptext.T("搜索会话"), Label: apptext.T("搜索会话"), TestID: "session-link-input",
				Style: core.Style{Height: core.Pt(34), Padding: core.Symmetric(0, 9), CornerRadius: ui.RadiusControl,
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text()}},
			core.List{Style: core.Style{Height: core.Pt(240), Padding: core.Edges{Right: viewkit.PanelInset}}, EstimatedSize: 34, Count: func() int { return len(filtered.Get()) },
				Key: func(i int) any { return filtered.Get()[i].ID }, Empty: ui.Text(apptext.T("没有匹配的会话"), 12, ui.Regular, colors.Muted),
				Row: func(cx *core.Scope, row core.ListRow) core.Node {
					return core.Dynamic(func(cx *core.Scope) core.Node {
						list, i := filtered.Get(), row.Index()
						if i < 0 || i >= len(list) {
							return nil
						}
						parent := list[i]
						item := composerRow(cx, lucide.Link, parent.title.Get(), "", org.Links[state.id].Parent == parent.ID, false, func() {
							if a.linkSession(child, parent) {
								a.closeSessionOrganizationDialog()
							}
						})
						item.TestID = "session-link-parent-" + parent.ID
						return item
					})
				}},
		}, Footer: footer}
}

// sessionRelationRows are the sessions linked to this one: the parent it
// was linked under and the ones that report back to it.
func (a *app) sessionRelationRows(cx *core.Scope, s *session) []core.Node {
	org := a.organization.Get()
	colors := ui.ColorsOf(cx)
	var rows []core.Node
	if parent := a.findSession(org.Links[s.ID].Parent); parent != nil {
		rows = append(rows, composerRow(cx, lucide.Link, apptext.T("父会话 · %s", parent.title.Get()), "", false, false, func() { a.selectSession(parent) }))
	}
	ids := slices.Sorted(maps.Keys(org.Links))
	slices.SortStableFunc(ids, func(a, b string) int { return org.Links[b].When.Compare(org.Links[a].When) })
	shown := 0
	for _, id := range ids {
		link := org.Links[id]
		if link.Parent != s.ID {
			continue
		}
		child := a.findSession(id)
		if child == nil {
			continue
		}
		if shown == 0 {
			rows = append(rows, ui.Text(apptext.T("子会话回报"), 11, ui.Medium, colors.Muted))
		}
		detail := link.Report
		if detail == "" && !link.When.IsZero() {
			detail = viewkit.WhenText(link.When, a.cx.Now())
		}
		row := composerRow(cx, lucide.MessageSquare, child.title.Get(), detail, false, false, func() { a.selectSession(child) })
		row.TestID = "session-link-report-" + id
		rows = append(rows, row)
		shown++
		if shown == 12 {
			break
		}
	}
	return rows
}
