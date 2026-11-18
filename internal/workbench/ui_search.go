//go:build !js && !android && !ios

package workbench

// The session search dialog: one field over every session's title and
// text, with the matched line under each result.

import (
	"fmt"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// searchDialog searches every session.
func (a *app) searchDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return ui.Dialog{
			Open:         a.searchOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.searchOpen.Set(open) },
			Title:        apptext.T("搜索会话"),
			TestID:       "session-search",
			Style:        core.Style{Width: core.Pt(680), Height: core.Pt(580)},
			Children: []core.Node{core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), Gap: 8}, Children: []core.Node{
				core.Input{Value: a.searchText.Get,
					OnChange:    func(v string) { a.searchText.Set(v); a.scheduleSearch() },
					OnSubmit:    func(string) { a.openSearchTop() },
					Placeholder: apptext.T("搜索所有会话的标题与内容…"), Label: apptext.T("搜索会话"), TestID: "search-input", AutoFocus: true,
					Style: core.Style{Height: core.Pt(34), Padding: core.Symmetric(0, 10), CornerRadius: 8,
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
						Color: colors.Text(), FontSize: 13}},
				choiceChips([]choice[string]{{"", "全部"}, {"title", "标题"}, {"body", "正文"}},
					func() string { return a.searchScope.Get() }, func(v string) { a.searchScope.Set(v) }),
				core.Dynamic(func(cx *core.Scope) core.Node {
					colors := ui.ColorsOf(cx)
					query := a.searchText.Get()
					hits := a.searchVisible()
					switch {
					case a.searchBusy.Get() && !a.searchIndexed:
						return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
							Children: []core.Node{ui.Spinner{Size: 16}, ui.Text(apptext.T("正在建立会话索引…"), 11.5, ui.Regular, colors.Muted)}}
					case query == "":
						_ = a.searchRev.Get()
						var recent []core.Node
						for _, q := range a.cfg.RecentSearches {
							q := q
							recent = append(recent, core.View{OnPress: func(core.PressEvent) {
								a.searchText.Set(q)
								a.scheduleSearch()
							}, Role: core.RoleButton, Label: apptext.T("最近搜索") + " " + q,
								StyleFunc: func() core.Style {
									return core.Style{Height: core.Pt(24), Padding: core.Symmetric(0, 9), CornerRadius: 12,
										BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
								},
								Children: []core.Node{ui.Text(q, 11, ui.Regular, colors.Muted)}})
						}
						recentRow := core.Node(core.View{})
						if len(recent) > 0 {
							recentRow = core.View{Style: core.Style{AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
								core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
									ui.Text(apptext.T("最近搜索"), 10, ui.Regular, colors.Faint),
									core.View{OnPress: func(core.PressEvent) { a.clearSearches() }, Role: core.RoleButton, Label: apptext.T("清除"),
										StyleFunc: func() core.Style {
											return core.Style{Height: core.Pt(20), Padding: core.Symmetric(0, 6), CornerRadius: 10,
												Hover: &core.Style{Background: colors.Hover()}}
										}, Children: []core.Node{ui.Text(apptext.T("清除"), 9.5, ui.Regular, colors.Faint)}},
								}},
								core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 5, JustifyContent: core.JustifyCenter}, Children: recent},
							}}
						}
						return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
							Children: []core.Node{
								ui.Icon(lucide.Search, 22, colors.Faint),
								ui.Text(apptext.T("输入关键词，搜索所有会话的标题与内容"), 12, ui.Regular, colors.Muted),
								ui.Text(fmt.Sprintf("索引里有 %d 个会话", len(a.searchDocs)), 10.5, ui.Regular, colors.Faint),
								recentRow,
							}}
					case len(hits) == 0:
						return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
							Children: []core.Node{
								ui.Icon(lucide.SearchX, 22, colors.Faint),
								ui.Text(apptext.T("没有匹配的会话"), 12, ui.Regular, colors.Muted),
							}}
					}
					var rows []core.Node
					for _, h := range hits {
						hit := h
						meta := projectLabel(hit.Cwd)
						if !hit.Updated.IsZero() {
							meta += " · " + viewkit.WhenText(hit.Updated, a.cx.Now())
						}
						if hit.Count > 0 {
							meta += apptext.T("· %d 处", hit.Count)
						}
						rows = append(rows, core.View{
							OnPress: func(core.PressEvent) { a.openSearchHit(hit) },
							Role:    core.RoleButton, Label: apptext.T("会话 ") + hit.Title, TestID: "search-hit",
							StyleFunc: func() core.Style {
								return core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 9, Padding: core.Symmetric(7, 8),
									CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()},
									Active: &core.Style{Background: colors.Pressed()}, Transition: viewkit.PressMotion}
							},
							Children: []core.Node{
								ui.Icon(lucide.MessageSquare, 13, colors.Faint),
								core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
									core.Text{Content: hit.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
										Style: core.Style{FontSize: 12.5, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
									core.Text{Content: meta, MaxLines: 1, Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
									core.Show{When: func() bool { return hit.Snippet != "" }, Then: func(*core.Scope) core.Node {
										return core.Text{Content: hit.Snippet, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
											Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Muted)}
									}},
								}},
							},
						})
					}
					total := 0
					for _, h := range hits {
						total += h.Count
					}
					return core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), Gap: 4}, Children: []core.Node{
						core.Text{Content: apptext.T("找到 %d 个会话 · %d 处匹配", len(hits), total),
							Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, Padding: core.Edges{Left: 2}},
							StyleFunc: ui.Colored(colors.Faint)},
						core.Scroll{Style: ui.FillRest, Children: []core.Node{
							core.View{Style: core.Style{Gap: 2, Padding: core.Edges{Right: 4}}, Children: rows},
						}},
					}}
				}),
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("重建索引"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "search-rebuild",
					OnPress: func() {
						a.searchIndexed = false
						a.loadSearchIndex(nil)
					}},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "search-close",
					OnPress: func() { a.searchOpen.Set(false) }},
			},
		}
	})
}
