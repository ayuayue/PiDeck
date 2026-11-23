//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"fmt"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// changeSummary lists the files a turn edited or wrote, folded to one
// line until opened; a path opens in the built-in editor.
func (a *app) changeSummary(s *session, t func() turn) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		s.uiSeq.Get() // redraw when the summary opens or closes
		tt := t()
		changes := turnChanges(tt)
		if len(changes) == 0 {
			return nil
		}
		key := s.ID + "/changes/" + tt.ID
		open := s.toolOpen(key, false)
		added, removed := 0, 0
		for _, c := range changes {
			added += c.Added
			removed += c.Removed
		}
		rowSize, detailSize := a.readingRowFont(), a.readingDetailFont()
		header := []core.Node{
			ui.Icon(lucide.FileDiff, 13, colors.Muted),
			core.Text{Content: fmt.Sprintf("修改 %d 个文件", len(changes)),
				Style: core.Style{FontSize: rowSize, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Muted)},
		}
		if added > 0 || removed > 0 {
			header = append(header,
				ui.Tabular(core.Text{Content: fmt.Sprintf("+%d", added), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: detailSize},
					StyleFunc: ui.Colored(colors.Up)}),
				ui.Tabular(core.Text{Content: fmt.Sprintf("−%d", removed), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: detailSize},
					StyleFunc: ui.Colored(colors.Danger)}))
		}
		header = append(header, ui.IconOf(func() *core.SVG {
			if open {
				return lucide.ChevronDown()
			}
			return lucide.ChevronRight()
		}, 11.5, colors.Faint))
		rows := []core.Node{core.View{
			OnPress: func(core.PressEvent) { s.toggleOpen(key) },
			Role:    core.RoleButton, Label: apptext.T("修改摘要"), TestID: "turn-changes",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(24),
					Padding: core.Symmetric(0, 4), CornerRadius: 5, Hover: &core.Style{Background: colors.Hover()}}
			},
			Children: header,
		}}
		if open {
			for i, c := range changes {
				change := c
				row := core.View{
					OnPress: func(core.PressEvent) { a.openChangedFile(s, change.Path) },
					Role:    core.RoleButton, Label: apptext.T("打开 ") + change.Path, TestID: fmt.Sprintf("turn-change-%d", i),
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(24),
							Padding: core.Symmetric(0, 6), CornerRadius: 5, Hover: &core.Style{Background: colors.Hover()}}
					},
					Children: []core.Node{
						core.Text{Content: change.Path, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(),
								FontSize: a.readingDetailFont()},
							StyleFunc: ui.Colored(colors.Muted)},
					},
				}
				if change.Added > 0 || change.Removed > 0 {
					row.Children = append(row.Children,
						ui.Tabular(core.Text{Content: fmt.Sprintf("+%d", change.Added), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: detailSize},
							StyleFunc: ui.Colored(colors.Up)}),
						ui.Tabular(core.Text{Content: fmt.Sprintf("−%d", change.Removed), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: detailSize},
							StyleFunc: ui.Colored(colors.Danger)}))
				}
				rows = append(rows, row)
			}
		}
		return core.View{Style: core.Style{Gap: 1, MinWidth: core.Pt(0)}, Children: rows}
	})
}
