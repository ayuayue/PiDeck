//go:build !js && !android && !ios

package workbench

// The session search dialog: one field over every session's title and
// text, with the matched line under each result.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
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
			Open: a.searchOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					a.closeSearch()
				}
			},
			Title:  apptext.T("搜索会话"),
			TestID: "session-search",
			Style:  core.Style{Width: a.dialogWidth(), Height: core.Pt(580)},
			Children: []core.Node{core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Gap: 8}, Children: []core.Node{
				a.searchBar(colors),
				choiceChips([]choice[string]{{"", "全部"}, {"title", "标题"}, {"body", "正文"}},
					func() string { return a.searchScope.Get() },
					func(v string) {
						a.searchScope.Set(v)
						a.searchPick.Set(0)
					}),
				core.Func(a.bindSearchKeys),
				core.Dynamic(func(cx *core.Scope) core.Node {
					colors := ui.ColorsOf(cx)
					if strings.TrimSpace(a.searchText.Get()) == "" {
						return a.searchEmpty()
					}
					result := a.searchResults.Get()
					if result == nil {
						message := apptext.T("搜索中…")
						if a.searchBusy.Get() {
							message = apptext.T("正在建立会话索引…")
						}
						return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
							Children: []core.Node{ui.Spinner{Size: 16}, ui.Text(message, 11.5, ui.Regular, colors.Muted)}}
					}
					hits := result.visible(a.searchScope.Get())
					if len(hits) == 0 {
						return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
							Children: []core.Node{
								ui.Icon(lucide.SearchX, 22, colors.Faint),
								ui.Text(apptext.T("没有匹配的会话"), 12, ui.Regular, colors.Muted),
							}}
					}
					total := 0
					for _, h := range hits {
						total += h.Count
					}
					return core.Func(func(cx *core.Scope) core.Node {
						window := core.NewSignal(cx, searchVisibleLimit)
						scroll := &scrollStash{}
						rowRefs := make([]core.Ref, len(hits))
						cx.Effect(func() {
							pick := max(0, min(a.searchPick.Get(), len(hits)-1))
							if pick >= window.GetUntracked() {
								window.Set(min(len(hits), (pick/searchVisibleLimit+1)*searchVisibleLimit))
							}
							cx.Post(func() { rowRefs[pick].Reveal(core.RevealOptions{Vertical: core.ScrollAlignNearest}) })
						})
						return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Gap: 4}, Children: []core.Node{
							core.Text{Content: apptext.T("找到 %d 个会话 · %d 处匹配", len(hits), total),
								Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, Padding: core.Edges{Left: 2}},
								StyleFunc: ui.Colored(colors.Faint)},
							scroll.Bind(cx, core.Scroll{TestID: "search-results", Style: ui.FillRest.Merge(core.Style{FlexShrink: 1, MinHeight: core.Pt(0)}), Children: []core.Node{
								core.Dynamic(func(cx *core.Scope) core.Node {
									end := min(window.Get(), len(hits))
									rows := make([]core.Node, 0, end+1)
									for i, hit := range hits[:end] {
										meta := projectLabel(hit.Cwd)
										if !hit.Updated.IsZero() {
											meta += " · " + viewkit.WhenText(hit.Updated, a.cx.Now())
										}
										if hit.Count > 0 {
											meta += apptext.T("· %d 处", hit.Count)
										}
										rows = append(rows, core.View{
											Ref:     &rowRefs[i],
											OnPress: func(core.PressEvent) { a.chooseSearchHit(result, hit) },
											Role:    core.RoleButton, Label: apptext.T("会话 ") + hit.Title, TestID: "search-hit",
											StyleFunc: func() core.Style {
												st := core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 9, Padding: core.Symmetric(7, 8),
													CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()},
													Active: &core.Style{Background: colors.Pressed()}, Transition: viewkit.PressMotion}
												// The picked row reads as the palette's selection: Return opens it.
												if a.searchPick.Get() == i {
													st.Background = colors.Pressed()
												}
												return st
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
									if end < len(hits) {
										rows = append(rows, ui.Button{Text: apptext.T("加载更多"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
											TestID: "search-more", OnPress: func() { window.Update(func(n int) int { return n + searchVisibleLimit }) }})
									}
									return core.View{Style: core.Style{Gap: 2, Padding: core.Edges{Right: scrollbarGutter}}, Children: rows}
								}),
							}}),
						}}
					})
				}),
			}}},
			Footer: []core.Node{
				core.Text{Content: apptext.T("↑↓ 选择，Enter 打开"),
					Style:     core.Style{FlexGrow: 1, FontFamily: viewkit.MonoFont(), FontSize: 9.5},
					StyleFunc: ui.Colored(colors.Faint)},
				ui.Button{Text: apptext.T("重建索引"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "search-rebuild",
					Disabled: a.searchBusy.Get, OnPress: a.rebuildSearch},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "search-close",
					OnPress: a.closeSearch},
			},
		}
	})
}

// searchBar is the palette's field: the icon, the query, and a clear
// button once there is something to clear.
func (a *app) searchBar(colors ui.Colors) core.Node {
	return core.View{
		Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(34), Padding: core.Symmetric(0, 10),
			CornerRadius: 8, Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()},
		Children: []core.Node{
			ui.Icon(lucide.Search, 13, colors.Faint),
			core.Input{Ref: a.searchFieldRef(), Value: a.searchText.Get,
				OnChange:       a.setSearchQuery,
				OnSubmit:       a.submitSearch,
				SubmitBehavior: core.SubmitBehaviorSubmit,
				Role:           core.RoleSearchField,
				Placeholder:    apptext.T("搜索所有会话的标题与内容…"), Label: apptext.T("搜索会话"), TestID: "search-input", AutoFocus: true,
				Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), Height: core.Pt(26), FontSize: 13, LineHeight: 18, Color: colors.Text()},
				StyleFunc: func() core.Style {
					return core.Style{PlaceholderColor: colors.Muted(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
				}},
			core.Show{When: func() bool { return a.searchText.Get() != "" }, Then: func(*core.Scope) core.Node {
				return ui.IconButton{Icon: lucide.X, Label: apptext.T("清空搜索"), Size: 22, IconSize: 13, TestID: "search-clear",
					Tint: func() core.Color { return colors.Faint() }, OnPress: a.clearSearch}
			}},
		}}
}

// bindSearchKeys moves the picked result as the command palette does, so
// the query stays where it is typed.
func (a *app) bindSearchKeys(cx *core.Scope) core.Node {
	cx.OnKeyWith("down", core.KeyOptions{When: core.KeyAlways, Repeat: true}, func() { a.moveSearchPick(1) })
	cx.OnKeyWith("up", core.KeyOptions{When: core.KeyAlways, Repeat: true}, func() { a.moveSearchPick(-1) })
	return nil
}

func (a *app) searchEmpty() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var indexStatus core.Node = ui.Text(apptext.T("索引里有 %d 个会话", len(a.searchDocs)), 10.5, ui.Regular, colors.Faint)
		if a.searchBusy.Get() {
			indexStatus = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6},
				Children: []core.Node{ui.Spinner{Size: 12}, ui.Text(apptext.T("正在建立会话索引…"), 10.5, ui.Regular, colors.Muted)}}
		}
		return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
			Children: []core.Node{
				ui.Icon(lucide.Search, 22, colors.Faint),
				core.Text{Content: apptext.T("输入关键词，搜索所有会话的标题与内容"), MaxLines: 2, Style: core.Style{MaxWidth: core.Pt(320), FontSize: 12},
					StyleFunc: ui.Colored(colors.Muted)},
				indexStatus,
				a.searchRecent(),
			}}
	})
}

func (a *app) searchRecent() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.searchRev.Get()
		if len(a.cfg.RecentSearches) == 0 {
			return core.View{}
		}
		colors := ui.ColorsOf(cx)
		var recent []core.Node
		for _, q := range a.cfg.RecentSearches {
			recent = append(recent, core.View{OnPress: func(core.PressEvent) {
				a.setSearchQuery(q)
				a.runSearch()
			},
				Role: core.RoleButton, Label: apptext.T("最近搜索") + " " + q,
				StyleFunc: func() core.Style {
					return core.Style{MinHeight: core.Pt(24), Padding: core.Symmetric(0, 9), CornerRadius: 12,
						MaxWidth: core.Pt(240), BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{core.Text{Content: q, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)}}})
		}
		return core.View{Style: core.Style{AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Text(apptext.T("最近搜索"), 11, ui.Regular, colors.Muted),
				ui.Button{Text: apptext.T("清除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					TestID: "search-clear-recent", OnPress: a.clearSearches},
			}},
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 5, JustifyContent: core.JustifyCenter}, Children: recent},
		}}
	})
}
