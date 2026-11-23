//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// turnMoreActions keeps secondary prompt and navigation actions available
// without making every completed answer end in a toolbar of equal weight.
func (a *app) turnMoreActions(s *session, t func() turn) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		item := func(icon func() *core.SVG, label, id string, disabled bool, press func()) base.MenuItem {
			row := a.menuRow(cx, icon, label, "", false, press)
			row.TestID = id
			row.Disabled = func() bool { return disabled }
			row.Style.Disabled = ui.Dimmed()
			return row
		}
		tt := t()
		rows := []core.Node{
			item(lucide.Quote, "复制提问", "", tt.Prompt == "", func() { a.copyText(tt.Prompt, "提问") }),
			item(lucide.PencilLine, "把提问放回输入框", "", tt.Prompt == "", func() { a.restoreTurnDraft(s, tt) }),
			item(lucide.Activity, "查看轨迹", "turn-trajectory", false, func() { a.openTrajectory(s, t()) }),
			item(lucide.GitBranch, "从这里分叉", "", !canBranchTurn(s, tt), func() { a.forkSession(s, tt.ID) }),
		}
		if canBranchTurn(s, tt) {
			rows = append(rows, item(lucide.RotateCcw, "在分支上重试", "turn-branch-retry", false, func() { a.retry(s, tt) }))
		}
		colors := ui.ColorsOf(cx)
		return base.Menu{Trigger: ui.Icon(lucide.Ellipsis, 14, colors.Muted),
			Label: apptext.T("更多操作"), TestID: "turn-more", Placement: core.PlaceBottom, Offset: 4, Margin: 8,
			Style: core.Style{Width: core.Pt(26), Height: core.Pt(26), FlexShrink: 0, CornerRadius: 6,
				AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
			StyleFunc: func() core.Style {
				return core.Style{Hover: &core.Style{Background: ui.Alpha(colors.Text(), 0.05)}, FocusVisible: ui.FocusRing(cx, 2)}
			},
			PopupStyle: a.menuPopup(cx), PopupStyleFunc: func() core.Style { return a.menuCard(cx) }, Children: rows}
	})
}
