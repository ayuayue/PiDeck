//go:build !js && !android && !ios

package workbench

// The review pane: the project's pull requests and issues in one list, a
// kind tab, a state filter and a search box, and the open item's
// conversation beside it. gh_data.go reads; this file only draws and sends
// the user's actions back.

import (
	"fmt"
	"strconv"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// reviewPane is the whole page.
func (a *app) reviewPane() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.langRev.Get()
		// Switching projects while the pane shows moves it to the new one.
		if !a.review.attachedTo(a.reviewWorkspace()) {
			a.cx.Post(a.reviewAttach)
		}
		return core.View{Style: core.Style{Direction: core.Column, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0)},
			Children: []core.Node{
				a.paneHeader(apptext.T("评审"), apptext.T("拉取请求与议题：查看、评论、合并，或交给会话评估。"), a.reviewHeaderActions(cx)),
				a.reviewScopeRow(cx),
				a.reviewToolbar(cx),
				core.View{Style: ui.FillRest, Children: []core.Node{
					core.Dynamic(func(cx *core.Scope) core.Node {
						st := a.review.state.Get()
						if st.Open != "" {
							return a.reviewDetail(cx)
						}
						return a.reviewList(cx, st)
					}),
				}},
			}}
	})
}

// reviewHeaderActions are the page's own buttons: refresh and the browser.
func (a *app) reviewHeaderActions(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	busy := func() bool { return a.review.state.Get().Loading || a.review.state.Get().DetailBusy }
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
		core.Show{When: func() bool { return busy() }, Then: func(cx *core.Scope) core.Node {
			return ui.Spinner{Size: 12, Label: apptext.T("正在读取")}
		}},
		hintOf(func() string { return apptext.T("刷新") }, ui.IconButton{Icon: lucide.RefreshCw, Label: apptext.T("刷新"),
			Size: 28, IconSize: 13.5, TestID: "review-refresh", OnPress: func() { a.review.reload(); a.review.reopenItem() }}),
		core.Show{When: func() bool {
			st := a.review.state.Get()
			return st.Detail != nil && st.Detail.Item.URL != ""
		}, Then: func(cx *core.Scope) core.Node {
			return hintOf(func() string { return apptext.T("在浏览器打开") }, ui.IconButton{Icon: lucide.ExternalLink, Label: apptext.T("在浏览器打开"),
				Size: 28, IconSize: 13.5, OnPress: func() {
					if st := a.review.state.GetUntracked(); st.Detail != nil && st.Detail.Item.URL != "" {
						a.cx.OpenURL(st.Detail.Item.URL, nil)
					}
				}})
		}},
		ui.Icon(lucide.GitBranch, 14, colors.Faint),
	}}
}

// reviewToolbar is the kind tab, the state filter and the search box.
func (a *app) reviewToolbar(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	tab := func(kind, label, icon string) core.Node {
		on := func() bool { return a.review.kind.Get() == kind }
		return core.View{OnPress: func(core.PressEvent) { a.review.setKind(kind) },
			Role: core.RoleTab, Label: apptext.T(label), TestID: "review-kind-" + kind,
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(28),
					Padding: core.Symmetric(0, 10), CornerRadius: 7, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				if on() {
					st.Background = colors.Surface()
					st.BorderWidth = 1
					st.BorderColor = colors.Border()
				}
				return st
			},
			Children: []core.Node{a.reviewKindIcon(icon, on), core.Text{Content: apptext.T(label), Style: core.Style{FontSize: 12.5, FontWeight: ui.Medium},
				StyleFunc: ui.Colored(colors.Text)}}}
	}
	filter := func(value, label string) core.Node {
		on := func() bool { return a.review.filter.Get() == value }
		return core.View{OnPress: func(core.PressEvent) { a.review.setFilter(value) },
			Role: core.RoleButton, Label: apptext.T(label), TestID: "review-filter-" + value,
			StyleFunc: func() core.Style {
				st := core.Style{Height: core.Pt(26), Padding: core.Symmetric(0, 9), CornerRadius: 6, AlignItems: core.AlignCenter,
					JustifyContent: core.JustifyCenter, Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()}}
				if on() {
					st.Background = colors.Inset()
				}
				return st
			},
			Children: []core.Node{ui.Text(apptext.T(label), 11.5, ui.Medium, func() core.Color {
				if on() {
					return colors.Text()
				}
				return colors.Muted()
			})}}
	}
	return core.View{Style: core.Style{Direction: core.Column, Gap: 8, Padding: core.Edges{Top: 10, Bottom: 10, Left: 20, Right: 20}},
		Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Wrap: core.Wrap}, Children: []core.Node{
				tab(reviewPR, "拉取请求", "pr"),
				tab(reviewIssue, "议题", "issue"),
				core.View{Style: core.Style{Width: core.Pt(8)}},
				filter(filterOpen, "打开"),
				filter(filterClosed, "已关闭"),
				filter(filterAll, "全部"),
				core.View{Style: core.Style{FlexGrow: 1}},
				core.Text{ContentFunc: func() string { return fmt.Sprint(len(a.review.state.Get().Items)) }, MaxLines: 1,
					Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)},
			}},
			a.reviewSearchField(colors),
		}}
}

// reviewScopeRow is what the list reads: the repository of the open
// project, and which of its repositories when it holds more than one.
func (a *app) reviewScopeRow(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Wrap: core.Wrap,
		Padding: core.Edges{Left: 20, Right: 20, Top: 10, Bottom: 6}}, Children: []core.Node{
		ui.Select[string]{Label: apptext.T("项目"), Placeholder: apptext.T("选择项目"), TestID: "review-project", Searchable: true,
			Style: core.Style{Width: core.Pt(220), FlexShrink: 1, MinWidth: core.Pt(120)},
			OptionsFunc: func() []ui.Option[string] {
				var options []ui.Option[string]
				for _, ws := range a.projects() {
					name := ws.label()
					if ws.Target.remote() {
						name += " · " + ws.Target.label()
					}
					options = append(options, ui.Option[string]{Value: projectWireKey(ws), Label: name})
				}
				return options
			}, Value: func() string {
				if ws := a.reviewWorkspace(); ws != nil {
					return projectWireKey(ws)
				}
				return ""
			}, OnChange: a.selectReviewProject},
		a.reviewRepoMenu(cx),
		core.View{Style: core.Style{FlexGrow: 1}},
		core.Text{ContentFunc: func() string {
			if a.review.state.Get().Loading {
				return apptext.T("正在读取…")
			}
			return ""
		}, MaxLines: 1, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
	}}
}

// reviewKindIcon is the tab's icon, in the accent when the tab is on.
func (a *app) reviewKindIcon(kind string, on func() bool) core.Node {
	icon := lucide.GitPullRequest
	if kind == "issue" {
		icon = lucide.CircleDot
	}
	return ui.IconOf(icon, 13, func() core.Color {
		colors := ui.ColorsOf(a.cx)
		if on() {
			return colors.Text()
		}
		return colors.Muted()
	})
}

// reviewSearchField is the search box: the list rereads on Return, or as
// soon as the box is cleared.
func (a *app) reviewSearchField(colors ui.Colors) core.Node {
	return core.Input{Value: a.review.search.Get, OnChange: func(text string) {
		a.review.search.Set(text)
		if strings.TrimSpace(text) == "" {
			a.review.setQuery("")
		}
	}, OnSubmit: func(text string) { a.review.setQuery(text) },
		Placeholder: apptext.T("搜索标题、编号或标签，回车确认"), Label: apptext.T("搜索拉取请求与议题"),
		TestID: "review-search",
		Style:  core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 9), FontSize: 12, Color: colors.Text()},
		StyleFunc: func() core.Style {
			return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 7,
				PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
		}}
}

// reviewList is the rows, or what to do instead of them.
func (a *app) reviewList(cx *core.Scope, st reviewState) core.Node {
	colors := ui.ColorsOf(cx)
	switch {
	case st.Missing:
		return reviewNotice(colors, lucide.Terminal, apptext.T("这台机器上没有 GitHub CLI"),
			apptext.T("装好 gh 并在终端运行 gh auth login，评审面板就会列出项目里的拉取请求与议题。"),
			apptext.T("重新读取"), func() { a.review.reload() })
	case st.NeedsLogin:
		return reviewNotice(colors, lucide.KeyRound, apptext.T("GitHub CLI 还没登录"),
			apptext.T("在终端运行 gh auth login，选好账号并授权；评审面板接着读这个仓库的拉取请求与议题。"),
			apptext.T("重新读取"), func() { a.review.reload() })
	case st.Error != "" && len(st.Items) == 0:
		return reviewNotice(colors, lucide.TriangleAlert, apptext.T("读不到 GitHub"), st.Error,
			apptext.T("重试"), func() { a.review.reload() })
	case st.Loading && len(st.Items) == 0:
		return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
			Children: []core.Node{ui.Spinner{Size: 16, Label: apptext.T("读取拉取请求与议题")}, ui.Text(apptext.T("正在读取…"), 12, ui.Regular, colors.Muted)}}
	case len(st.Items) == 0 && len(a.projects()) == 0:
		return reviewNotice(colors, lucide.FolderOpen, apptext.T("先打开一个项目"),
			apptext.T("评审面板读的是项目所在的 GitHub 仓库。"), apptext.T("添加工作区"), func() { a.pickNative("workspace") })
	case len(st.Items) == 0:
		if a.review.kind.Get() == reviewPR {
			return reviewNotice(colors, lucide.GitPullRequest, apptext.T("没有符合条件的拉取请求"),
				apptext.T("换一个状态筛选，或清空搜索再试。"), apptext.T("刷新"), func() { a.review.reload() })
		}
		return reviewNotice(colors, lucide.CircleDot, apptext.T("没有符合条件的议题"),
			apptext.T("换一个状态筛选，或清空搜索再试。"), apptext.T("刷新"), func() { a.review.reload() })
	}
	rows := make([]core.Node, 0, len(st.Items)+1)
	for _, item := range st.Items {
		rows = append(rows, a.reviewRow(cx, item))
	}
	if len(st.Items) >= st.Limit && st.Limit < 200 {
		rows = append(rows, core.View{Style: core.Style{AlignItems: core.AlignCenter, Padding: core.All(8)}, Children: []core.Node{
			ui.Button{Text: apptext.T("加载更多"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.review.loadMore() }}}})
	}
	if st.Error != "" {
		rows = append(rows, core.Text{Content: st.Error, MaxLines: 3, Style: core.Style{FontSize: 11, Padding: core.All(8)},
			StyleFunc: ui.Colored(colors.Danger)})
	}
	return core.Scroll{Style: ui.FillRest, Children: []core.Node{
		core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Left: 14, Right: 14, Bottom: 16}}, Children: rows}}}
}

// reviewRow is one pull request or issue.
func (a *app) reviewRow(cx *core.Scope, item reviewItem) core.Node {
	row := item
	colors := ui.ColorsOf(cx)
	return core.View{TestID: "review-row-" + reviewKey(row), OnPress: func(core.PressEvent) { a.review.openItem(row) },
		Role: core.RoleButton, Label: fmt.Sprintf("#%d %s", row.Number, row.Title),
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(46),
				Padding: core.Symmetric(6, 8), CornerRadius: 8, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		}, Children: []core.Node{
			ui.IconOf(reviewIcon(row), 14, func() core.Color { return reviewStateColor(colors, row) }),
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.Text{Content: "#" + strconv.Itoa(row.Number), MaxLines: 1,
						Style: core.Style{FontSize: 11.5, FontFamily: viewkit.MonoFont()}, StyleFunc: ui.Colored(colors.Faint)},
					core.Text{Content: row.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return row.Draft }, Then: func(*core.Scope) core.Node {
						return ui.Badge{Text: apptext.T("草稿"), Variant: ui.BadgeNeutral}
					}},
				}},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.Text{ContentFunc: func() string {
						meta := row.Author
						if row.Kind == reviewPR && row.Branch != "" {
							meta += " · " + row.Branch
							if row.Base != "" {
								meta += " → " + row.Base
							}
						}
						return meta
					}, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
					core.Text{Content: viewkit.WhenText(row.Updated, a.cx.Now()), MaxLines: 1,
						Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
					reviewLabelChips(colors, row.Labels),
				}},
			}},
			a.reviewRowMarks(colors, row),
		}}
}

// reviewRowMarks are the row's right end: checks, review verdict and lines.
func (a *app) reviewRowMarks(colors ui.Colors, row reviewItem) core.Node {
	var marks []core.Node
	switch row.Checks {
	case checksPass:
		marks = append(marks, ui.Icon(lucide.CircleCheck, 12, colors.Up))
	case checksFail:
		marks = append(marks, ui.Icon(lucide.CircleX, 12, colors.Danger))
	case checksPending:
		marks = append(marks, ui.Icon(lucide.Clock, 12, colors.Warn))
	}
	switch row.Review {
	case "APPROVED":
		marks = append(marks, ui.Icon(lucide.CheckCheck, 12, colors.Up))
	case "CHANGES_REQUESTED":
		marks = append(marks, ui.Icon(lucide.MessageSquareWarning, 12, colors.Danger))
	case "REVIEW_REQUIRED":
		marks = append(marks, ui.Icon(lucide.Eye, 12, colors.Warn))
	}
	if row.Kind == reviewPR && (row.Adds > 0 || row.Deletes > 0) {
		marks = append(marks, core.View{Style: core.Style{Direction: core.Row, Gap: 3, FlexShrink: 0}, Children: []core.Node{
			ui.Text("+"+strconv.Itoa(row.Adds), 10.5, ui.Medium, colors.Up),
			ui.Text("-"+strconv.Itoa(row.Deletes), 10.5, ui.Medium, colors.Danger),
		}})
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, FlexShrink: 0}, Children: marks}
}

// reviewLabelChips draws as many labels as a row has room for.
func reviewLabelChips(colors ui.Colors, labels []string) core.Node {
	if len(labels) == 0 {
		return nil
	}
	shown := labels
	if len(shown) > 3 {
		shown = shown[:3]
	}
	chips := make([]core.Node, 0, len(shown))
	for _, l := range shown {
		chips = append(chips, core.View{StyleFunc: func() core.Style {
			return core.Style{Padding: core.Symmetric(0, 5), Height: core.Pt(15), CornerRadius: 4, JustifyContent: core.JustifyCenter,
				Background: colors.Inset(), BorderWidth: 1, BorderColor: colors.Line()}
		}, Children: []core.Node{ui.Text(l, 9, ui.Medium, colors.Muted)}})
	}
	return core.View{Style: core.Style{Direction: core.Row, Gap: 3, FlexShrink: 0}, Children: chips}
}

// reviewNotice is a page-sized explanation with one action.
func reviewNotice(colors ui.Colors, icon func() *core.SVG, title, note, action string, press func()) core.Node {
	return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Padding: core.All(28), Gap: 9},
		Children: []core.Node{
			ui.Icon(icon, 24, colors.Faint),
			ui.Text(title, 13, ui.Semibold, colors.Text),
			core.View{Style: core.Style{MaxWidth: core.Pt(360)}, Children: []core.Node{
				core.Text{Content: note, MaxLines: 4, Style: core.Style{FontSize: 11.5, LineHeight: 17, TextAlign: core.TextAlignCenter},
					StyleFunc: ui.Colored(colors.Muted)}}},
			ui.Button{Text: action, Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: press},
		}}
}

// reviewIcon is the row's kind and state in one glyph.
func reviewIcon(item reviewItem) func() *core.SVG {
	return viewkit.ReviewGlyph(item.State, item.Kind == reviewPR)
}

// reviewStateColor colors the row's glyph.
func reviewStateColor(colors ui.Colors, item reviewItem) core.Color {
	return viewkit.ReviewGlyphColor(colors, item.State, item.Checks == checksFail)
}
