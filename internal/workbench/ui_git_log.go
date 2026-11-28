//go:build !js && !android && !ios

package workbench

// The Git drawer's history: the newest few commits, a filter, and a way to
// read further back. A long log stays folded so the panel keeps its shape.

import (
	"fmt"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/base/commitgraph"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitHistory is the commits under the changes.
func (a *app) gitHistory(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	search := core.Input{Value: a.git.logQuery.Get, OnChange: a.setGitLogQuery,
		Placeholder: apptext.T("搜索提交（标题、作者或哈希）…"), Label: apptext.T("搜索提交"), TestID: "git-log-search",
		Style: core.Style{Height: core.Pt(viewkit.PanelFieldHeight), Padding: core.Symmetric(0, 12), CornerRadius: 8,
			FontSize: viewkit.PanelTextSize, LineHeight: viewkit.PanelLineHeight},
		StyleFunc: func() core.Style {
			return core.Style{Color: colors.Text(), PlaceholderColor: colors.Muted(), Background: colors.Field(),
				BorderWidth: 1, BorderColor: colors.FieldBorder(),
				CaretColor: colors.Text(), SelectionColor: colors.Now().Selection, FocusVisible: ui.FocusRing(cx, 2)}
		}}
	return core.View{Style: core.Style{Gap: viewkit.PanelGap}, Children: []core.Node{
		a.gitHistoryBar(cx),
		search,
		core.Dynamic(func(cx *core.Scope) core.Node { return a.gitHistoryRows(cx) }),
	}}
}

// gitHistoryBar is the section's heading.
func (a *app) gitHistoryBar(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(viewkit.PanelControlSize)}, Children: []core.Node{
		gitSectionTitle(colors, apptext.T("历史")),
		gitCount(colors, func() string { return fmt.Sprint(a.git.state.Get().historyCount()) }),
		core.View{Style: core.Style{FlexGrow: 1}},
		hint("刷新历史", a.pressIcon(lucide.RefreshCw, apptext.T("刷新历史"), viewkit.PanelControlSize, viewkit.PanelIconSize,
			func() bool { return a.git.busy.Get() != "" }, func() { a.git.refreshAll() }, "git-log-refresh")),
	}}
}

// gitHistoryRows is the log itself: the pages of history the drawer has
// read, or the commits a query matches anywhere in the repository.
func (a *app) gitHistoryRows(cx *core.Scope) core.Node {
	query := strings.TrimSpace(a.git.logQuery.Get())
	if query != "" {
		return a.gitHistoryHits(cx, query)
	}
	colors := ui.ColorsOf(cx)
	st := a.git.state.Get()
	shown := min(a.git.historyShown.Get(), len(st.Commits))
	var rows []core.Node
	for i, c := range st.Commits[:shown] {
		rows = append(rows, a.gitCommitRow(cx, i, c, true))
	}
	switch {
	case len(st.Commits) == 0:
		rows = append(rows, a.gitNotice(apptext.T("还没有提交"), colors.Faint))
	case shown < len(st.Commits):
		rows = append(rows, a.gitListTail(apptext.T("显示更早的提交"), "git-log-more", a.moreGitHistory))
	case st.Total > len(st.Commits):
		rows = append(rows, a.gitListTail(apptext.T("加载更多提交"), "git-log-more", a.moreGitHistory))
	}
	return core.View{Style: core.Style{Gap: 0}, Children: rows}
}

// gitHistoryHits draws a query's matches. Until the repository-wide answer
// lands, the page already read answers, so typing stays quick.
func (a *app) gitHistoryHits(cx *core.Scope, query string) core.Node {
	colors := ui.ColorsOf(cx)
	res := a.git.logSearch.Get()
	settled := res != nil && res.Query == query && !res.Loading
	var commits []gitCommit
	more := false
	switch {
	case settled && res.Error != "":
		return a.gitNotice(res.Error, colors.Danger)
	case settled:
		commits, more = res.Commits, len(res.Commits) >= a.git.searchLimit.Get()
	default:
		for _, c := range a.git.state.Get().Commits {
			if commitMatches(c, query) {
				commits = append(commits, c)
			}
		}
	}
	var rows []core.Node
	for _, c := range commits {
		rows = append(rows, a.gitCommitRow(cx, 0, c, false))
	}
	switch {
	case len(commits) == 0:
		rows = append(rows, a.gitNotice(apptext.T("没有匹配的提交"), colors.Faint))
	case more:
		rows = append(rows, a.gitListTail(apptext.T("显示更早的提交"), "git-log-more", a.moreGitSearch))
	}
	return core.View{Style: core.Style{Gap: 0}, Children: rows}
}

// gitNotice is one quiet line standing in for rows.
func (a *app) gitNotice(text string, color func() core.Color) core.Node {
	return core.Text{Content: text, Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight, Padding: core.Symmetric(8, 6)}, StyleFunc: ui.Colored(color)}
}

// gitCommitRow is one commit: its graph lane, subject and line of facts,
// with a right-click menu for what can be done with it.
func (a *app) gitCommitRow(cx *core.Scope, i int, commit gitCommit, graph bool) core.Node {
	colors := ui.ColorsOf(cx)
	return base.ContextMenu{
		Trigger: core.View{
			OnPress: func(core.PressEvent) { a.gitShowCommit(commit) },
			Role:    core.RoleButton, Label: commit.Subject, TestID: "git-commit-row",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(48),
					Padding: core.Edges{Left: 4, Right: 4}, CornerRadius: 6, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()},
					FocusVisible: ui.FocusRing(cx, 2)}
			},
			Children: []core.Node{
				core.Show{When: func() bool { return graph }, Then: func(*core.Scope) core.Node {
					return commitgraph.Graph{History: a.git.history, Item: func() commitgraph.Item { return a.git.history.At(i) },
						Height: 48, Lane: 12, Color: func(line int) core.Color {
							palette := []core.Color{colors.Muted(), colors.Up(), colors.Warn(), colors.Danger(), colors.Faint()}
							return palette[max(0, line)%len(palette)]
						}}
				}},
				core.Show{When: func() bool { return !graph }, Then: func(*core.Scope) core.Node {
					return ui.Icon(lucide.GitCommitHorizontal, viewkit.PanelDetailIconSize, colors.Muted)
				}},
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
					core.Text{Content: commit.Subject, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: viewkit.PanelTextSize, LineHeight: viewkit.PanelLineHeight}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: commitLine(commit), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)},
				}},
				ui.Icon(lucide.ChevronRight, 12, colors.Faint),
			},
		},
		Children: []core.Node{
			a.menuRow(a.cx, lucide.FileDiff, apptext.T("查看提交详情"), "", false, func() { a.gitShowCommit(commit) }),
			a.menuRow(a.cx, lucide.Copy, apptext.T("复制哈希"), "", false, func() { a.copyText(commit.Hash, "哈希") }),
			a.menuRow(a.cx, lucide.Copy, apptext.T("复制提交说明"), "", false, func() { a.copyText(commit.Subject, "提交说明") }),
			a.menuRow(a.cx, lucide.ExternalLink, apptext.T("在浏览器打开提交"), "", false, func() { a.openCommitInBrowser(commit) }),
		},
		PopupStyle:     core.Style{MinWidth: core.Pt(180)},
		PopupStyleFunc: func() core.Style { return a.menuCard(a.cx) },
	}
}

// commitLine is a commit's short hash, author and day.
func commitLine(c gitCommit) string {
	parts := []string{c.Short}
	if c.Author != "" {
		parts = append(parts, c.Author)
	}
	if !c.Date.IsZero() {
		parts = append(parts, c.Date.Format("2006-01-02"))
	}
	return strings.Join(parts, " · ")
}

// gitTone colors a changed file's mark.
func gitTone(f gitFile, colors ui.Colors) core.Color {
	switch {
	case f.Conflicted:
		return colors.Danger()
	case f.Untracked:
		return colors.Faint()
	case f.mark() == "D":
		return colors.Danger()
	case f.mark() == "A":
		return colors.Up()
	case f.mark() == "R", f.mark() == "C":
		return colors.Info()
	case f.mark() == "M", f.mark() == "T":
		return colors.Warn()
	}
	return colors.Muted()
}
