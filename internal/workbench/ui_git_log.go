//go:build !js && !android && !ios

package workbench

// The Git drawer: the branch and its upstream, changed files with their
// stage, unstage and discard actions, the commit box, the history and the
// patch dialog. The repository is read by git.go; this file only draws it
// and sends the user's actions back.

import (
	"fmt"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/base/commitgraph"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitHistory lists the latest commits.
func (a *app) gitHistory(cx *core.Scope, st gitState) core.Node {
	colors := ui.ColorsOf(cx)
	search := core.Input{Value: a.git.logQuery.Get, OnChange: a.git.logQuery.Set,
		Placeholder: apptext.T("搜索提交（标题、作者或哈希）…"), Label: apptext.T("搜索提交"), TestID: "git-log-search",
		Style: core.Style{Height: core.Pt(26), Padding: core.Symmetric(0, 8), CornerRadius: 6,
			Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
			Color: colors.Text(), FontSize: 10.5}}
	list := core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		query := strings.ToLower(strings.TrimSpace(a.git.logQuery.Get()))
		var rows []core.Node
		shown := 0
		for i, c := range st.Commits {
			i, commit := i, c
			if query != "" {
				hay := strings.ToLower(commit.Subject + " " + commit.Author + " " + commit.Short + " " + commit.Hash)
				if !strings.Contains(hay, query) {
					continue
				}
			}
			shown++
			rows = append(rows, base.ContextMenu{
				Trigger: core.View{
					OnPress: func(core.PressEvent) { a.gitShowCommit(commit) },
					Role:    core.RoleButton, Label: commit.Subject, TestID: "git-commit-row",
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(36),
							Padding: core.Edges{Left: 4, Right: 2}, CornerRadius: 6, Transition: viewkit.PressMotion,
							Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
					},
					Children: []core.Node{
						core.Show{When: func() bool { return query == "" }, Then: func(*core.Scope) core.Node {
							return commitgraph.Graph{History: a.git.history, Item: func() commitgraph.Item { return a.git.history.At(i) },
								Height: 36, Lane: 10, Color: func(line int) core.Color {
									palette := []core.Color{colors.Muted(), colors.Up(), colors.Warn(), colors.Danger(), colors.Faint()}
									return palette[max(0, line)%len(palette)]
								}}
						}},
						core.Show{When: func() bool { return query != "" }, Then: func(*core.Scope) core.Node {
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
				PopupStyle: core.Style{MinWidth: core.Pt(180)},
				PopupStyleFunc: func() core.Style {
					return a.menuCard(a.cx)
				},
			})
		}
		if len(rows) == 0 {
			msg := apptext.T("还没有提交")
			if query != "" {
				msg = apptext.T("没有匹配的提交")
			}
			rows = append(rows, core.Text{Content: msg, Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		if query == "" && st.LogLimit > 0 && len(st.Commits) >= st.LogLimit && st.LogLimit < 500 {
			rows = append(rows, core.View{OnPress: func(core.PressEvent) { a.git.loadMore() },
				Role: core.RoleButton, Label: apptext.T("加载更多提交"), TestID: "git-log-more",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
						Height: core.Pt(26), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
				}, Children: []core.Node{ui.Text(apptext.T("加载更多提交"), 10.5, ui.Regular, colors.Muted)}})
		}
		return core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				core.Text{Content: apptext.T("历史"), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, LetterSpacing: 0.5}, StyleFunc: ui.Colored(colors.Faint)},
				core.Text{Content: fmt.Sprint(shown), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
				core.View{Style: core.Style{FlexGrow: 1}},
				a.pressIcon(lucide.RefreshCw, apptext.T("刷新历史"), 21, 11, nil, func() { a.git.refreshAll() }, ""),
			}},
			core.View{Style: core.Style{Gap: 0}, Children: rows},
		}}
	})
	return core.View{Style: core.Style{Gap: 3}, Children: []core.Node{
		search,
		list,
	}}
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
