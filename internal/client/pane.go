package client

// The surfaces a phone opens over the page — a project's files, its Git, its
// review — stand beside it instead once the window is as wide as a desktop's:
// the rail, the page and the surface, three columns. A phone has no room for
// the third, so there they stay the sheet they were.

import (
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// paneMinWidth is the least window that has room for three columns.
const paneMinWidth core.Points = 1100

// paneBeside says the window has room to keep a surface beside the page.
func paneBeside(cx *core.Scope) bool { return cx.Env().Window().Width >= paneMinWidth }

// paneWidth is that column's width: a third of the window, within the bounds
// of a panel a person can read a diff in.
func paneWidth(cx *core.Scope) core.Points {
	return core.Points(min(520, max(360, cx.Env().Window().Width*0.34)))
}

// sheetSpec is one surface, as both presentations need it: what its head
// says, whether it is open, how to close it, and its own content.
type sheetSpec struct {
	title  string
	testID string
	open   func() bool
	close  func()
	width  core.Points // the sheet's width on a phone
	body   []core.Node
	footer []core.Node
}

// sheetFrame is a surface's chrome: the phone's sheet, or the column beside
// the page. The content is the surface's own either way.
func sheetFrame(cx *core.Scope, s sheetSpec) core.Node {
	if !paneBeside(cx) {
		return ui.Dialog{
			Open: s.open,
			OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					s.close()
				}
			},
			Title: s.title, TestID: s.testID,
			Style:    core.Style{Width: core.Pct(100), MaxWidth: core.Pt(s.width)},
			Children: s.body, Footer: s.footer,
		}
	}
	colors := ui.ColorsOf(cx)
	return core.Show{When: s.open, Then: func(cx *core.Scope) core.Node {
		return core.View{TestID: s.testID, Style: core.Style{Direction: core.Column, Width: core.Pt(paneWidth(cx)), FlexShrink: 0,
			MinHeight: core.Pt(0), Background: colors.Surface(), Borders: core.Edges{Left: 1},
			BorderColors: core.EdgeColors{Left: colors.Line()}}, Children: []core.Node{
			paneHead(cx, s.testID, s.title, s.close),
			core.View{Style: core.Style{Direction: core.Column, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0),
				Padding: core.Symmetric(8, 12), Gap: 6}, Children: s.body},
			paneFooter(cx, s.footer),
		}}
	}}
}

// paneHead is a pane's title row, with the way out of it.
func paneHead(cx *core.Scope, testID, title string, close func()) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(46),
		Padding: core.Symmetric(6, 12), Borders: core.Edges{Bottom: 1},
		BorderColors: core.EdgeColors{Bottom: colors.Line()}}, Children: []core.Node{
		core.Text{Content: title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
			Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 13, FontWeight: ui.Semibold},
			StyleFunc: ui.Colored(colors.Text)},
		core.View{OnPress: func(core.PressEvent) { close() }, Role: core.RoleButton, Label: apptext.T("关闭"),
			TestID: testID + "-pane-close",
			StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(28), Height: core.Pt(28), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
					CornerRadius: 7, Active: &core.Style{Background: colors.Pressed()}}
			}, Children: []core.Node{ui.Icon(lucide.X, 14, colors.Faint)}},
	}}
}

// paneFooter is a pane's actions, when the surface has any.
func paneFooter(cx *core.Scope, footer []core.Node) core.Node {
	if len(footer) == 0 {
		return core.View{}
	}
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{Direction: core.Row, JustifyContent: core.JustifyEnd, Gap: 8, Padding: core.Symmetric(8, 12),
		Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Line()}}, Children: footer}
}
