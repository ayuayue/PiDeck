//go:build !js && !android && !ios

package workbench

// The Git drawer's history: the newest few commits, a filter, and a way to
// read further back. A long log stays folded so the panel keeps its shape.

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/base/commitgraph"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitHistory is the commits under the changes.
func (a *app) gitHistory(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	search := core.Input{Value: a.git.logQuery.Get, OnChange: a.git.logQuery.Set,
		Placeholder: apptext.T("搜索提交（标题、作者或哈希）…"), Label: apptext.T("搜索提交"), TestID: "git-log-search",
		Style: core.Style{Height: core.Pt(26), Padding: core.Symmetric(0, 8), CornerRadius: 6,
			Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
			Color: colors.Text(), FontSize: 10.5},
		StyleFunc: func() core.Style {
			return core.Style{PlaceholderColor: colors.Faint(), Background: colors.Field(),
				BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6,
				CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
		}}
	return core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
		a.gitHistoryBar(cx),
		search,
		core.Dynamic(func(cx *core.Scope) core.Node { return a.gitHistoryRows(cx) }),
	}}
}

// gitHistoryBar is the section's heading.
func (a *app) gitHistoryBar(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, MinHeight: core.Pt(22)}, Children: []core.Node{
		gitSectionTitle(colors, apptext.T("历史")),
		gitCount(colors, func() string { return fmt.Sprint(len(a.git.state.Get().Commits)) }),
		core.View{Style: core.Style{FlexGrow: 1}},
		hint("刷新历史", a.pressIcon(lucide.RefreshCw, apptext.T("刷新历史"), 21, 11,
			func() bool { return a.git.busy.Get() != "" }, func() { a.git.refreshAll() }, "git-log-refresh")),
	}}
}

// gitHistoryRows is the log itself, cut to the rows the user asked for.
func (a *app) gitHistoryRows(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	st := a.git.state.Get()
	query := strings.ToLower(strings.TrimSpace(a.git.logQuery.Get()))
	shown := a.git.historyShown.Get()
	var rows []core.Node
	matched, visible := 0, 0
	for i, c := range st.Commits {
		if query != "" {
			hay := strings.ToLower(c.Subject + " " + c.Author + " " + c.Short + " " + c.Hash)
			if !strings.Contains(hay, query) {
				continue
			}
		}
		matched++
		if visible >= shown {
			continue
		}
		visible++
		rows = append(rows, a.gitCommitRow(cx, i, c, query == ""))
	}
	switch {
	case matched == 0:
		msg := apptext.T("还没有提交")
		if query != "" {
			msg = apptext.T("没有匹配的提交")
		}
		rows = append(rows, core.Text{Content: msg, Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
			StyleFunc: ui.Colored(colors.Faint)})
	case matched > visible:
		rows = append(rows, a.gitListTail(apptext.T("显示更早的提交"), "git-log-more", a.moreGitHistory))
	case query == "" && st.LogLimit > 0 && len(st.Commits) >= st.LogLimit && st.LogLimit < 500:
		rows = append(rows, a.gitListTail(apptext.T("加载更多提交"), "git-log-more", a.moreGitHistory))
	}
	return core.View{Style: core.Style{Gap: 0}, Children: rows}
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
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(36),
					Padding: core.Edges{Left: 4, Right: 2}, CornerRadius: 6, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{
				core.Show{When: func() bool { return graph }, Then: func(*core.Scope) core.Node {
					return commitgraph.Graph{History: a.git.history, Item: func() commitgraph.Item { return a.git.history.At(i) },
						Height: 36, Lane: 10, Color: func(line int) core.Color {
							palette := []core.Color{colors.Muted(), colors.Up(), colors.Warn(), colors.Danger(), colors.Faint()}
							return palette[max(0, line)%len(palette)]
						}}
				}},
				core.Show{When: func() bool { return !graph }, Then: func(*core.Scope) core.Node {
					return ui.Icon(lucide.GitCommitHorizontal, 12, colors.Faint)
				}},
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
					core.Text{Content: commit.Subject, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 11.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: commitLine(commit), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9, LineHeight: 12}, StyleFunc: ui.Colored(colors.Faint)},
				}},
				ui.Icon(lucide.ChevronRight, 10, colors.Faint),
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
