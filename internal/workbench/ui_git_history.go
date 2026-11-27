//go:build !js && !android && !ios

package workbench

// The commits that touched one file.

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// fileHistoryPane lists a file's commits; a press opens the commit's patch
// beside it.
func (a *app) fileHistoryPane() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.gitFileHistoryRev.Get()
		_ = a.langRev.Get()
		commits := a.gitFileHistory
		errText := a.gitFileHistoryErr.Get()
		var rows []core.Node
		for _, c := range commits {
			c := c
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) { a.gitShowCommit(c) },
				Role:    core.RoleButton, Label: c.Short + " " + c.Subject, TestID: "git-history-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(48),
						Padding: core.Symmetric(4, 8), CornerRadius: 6, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()},
						FocusVisible: ui.FocusRing(cx, 2)}
				},
				Children: []core.Node{
					ui.Icon(lucide.GitCommitHorizontal, viewkit.PanelDetailIconSize, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
						core.Text{Content: c.Subject, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: viewkit.PanelTextSize, LineHeight: viewkit.PanelLineHeight}, StyleFunc: ui.Colored(colors.Text)},
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinWidth: core.Pt(0)}, Children: []core.Node{
							core.Text{Content: c.Short, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: viewkit.PanelCaptionSize}, StyleFunc: ui.Colored(colors.Muted)},
							core.Text{Content: c.Author, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
								Style: core.Style{FontSize: viewkit.PanelCaptionSize, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Muted)},
							core.Text{Content: c.Date.Format("2006-01-02"), Style: core.Style{FontSize: viewkit.PanelCaptionSize}, StyleFunc: ui.Colored(colors.Muted)},
						}},
					}},
				}})
		}
		var body core.Node
		switch {
		case errText != "":
			body = core.Text{Content: errText, Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight, Padding: core.All(8)}, StyleFunc: ui.Colored(colors.Danger)}
		case len(rows) == 0:
			body = core.Text{Content: apptext.T("还没有改过这个文件。"), Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Muted)}
		default:
			body = a.scrollStashFor("fileHistoryPane:1").Bind(cx, core.Scroll{TestID: "git-file-history-scroll", Style: ui.FillRest, Children: []core.Node{
				core.View{TestID: "git-file-history-content", Style: core.Style{Gap: 1, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: rows}}})
		}
		return core.View{Style: core.Style{Direction: core.Column, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0)},
			Children: []core.Node{
				a.paneHeader("文件历史", a.gitFileHistoryPath.Get()),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Padding: core.Symmetric(10, 0)},
					Children: []core.Node{body}},
			}}
	})
}
