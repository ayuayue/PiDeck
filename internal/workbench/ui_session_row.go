//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// sessionRowOf is one session in the rail, given its value.
func (a *app) sessionRowOf(sess *session, pinned bool) core.Node {
	return a.sessionRowFn(func() *session { return sess })
}

// sessionRowFn is one session in the rail.
func (a *app) sessionRowFn(s func() *session) core.Node {
	colors := ui.ColorsOf(a.cx)
	selected := func() bool { return a.activeID.Get() == s().ID }
	return base.ContextMenu{
		Trigger: core.View{
			OnPress: func(core.PressEvent) { a.selectSession(s()) },
			Role:    core.RoleButton, LabelFunc: func() string { return s().title.Get() }, TestID: "session-row",
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(28), Padding: core.Symmetric(0, 8),
					CornerRadius: 7, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				if selected() {
					st.Background = colors.Pressed()
				}
				return st
			},
			Children: []core.Node{
				core.View{StyleFunc: func() core.Style {
					c := colors.Faint()
					switch s().status.Get() {
					case statusRunning:
						c = viewkit.Thinking
					case statusWaiting:
						c = viewkit.Warning
					case statusFailed:
						c = colors.Danger()
					case statusStarting:
						c = colors.Accent()
					}
					return core.Style{Width: core.Pt(5), Height: core.Pt(5), CornerRadius: 3, Background: c, FlexShrink: 0}
				}},
				core.Text{ContentFunc: func() string { return s().title.Get() }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, LineHeight: 18},
					StyleFunc: func() core.Style {
						w := ui.Regular
						if selected() {
							w = ui.Medium
						}
						return core.Style{Color: colors.Text(), FontWeight: w}
					}},
				core.Show{When: func() bool { return a.cfg.ForkParents[s().ID] != "" }, Then: func(*core.Scope) core.Node {
					return ui.Icon(lucide.GitBranch, 10.5, colors.Faint)
				}},
				core.Show{When: func() bool { return s().External }, Then: func(*core.Scope) core.Node {
					return ui.Icon(lucide.Clock, 10.5, colors.Faint)
				}},
				core.Show{When: func() bool { return a.isPinned(s().ID) }, Then: func(*core.Scope) core.Node {
					return ui.Icon(lucide.Star, 11, colors.Faint)
				}},
				core.Show{When: func() bool { return a.sessionArchived(s().ID) }, Then: func(*core.Scope) core.Node {
					return ui.Icon(lucide.Archive, 10.5, colors.Faint)
				}},
				// A question waits: say so where the session is listed, as a
				// session can wait in the background.
				core.Show{When: func() bool {
					n := 0
					if s().askPending != nil {
						n = s().askPending.Get()
					}
					return n > 0
				}, Then: func(cx *core.Scope) core.Node {
					return core.View{TestID: "ask-badge", StyleFunc: func() core.Style {
						c := ui.ColorsOf(cx)
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 3, Padding: core.Symmetric(1, 5),
							CornerRadius: 5, Background: ui.Alpha(c.Accent(), 0.16), FlexShrink: 0}
					}, Children: []core.Node{
						ui.IconOf(lucide.BadgeQuestionMark, 9, func() core.Color { return ui.ColorsOf(cx).Accent() }),
						ui.Textf(func() string { return apptext.T("待确认") }, 9, ui.Medium, func() core.Color { return ui.ColorsOf(cx).Accent() }),
					}}
				}},
				core.Text{ContentFunc: func() string { return viewkit.WhenText(s().updated.Get(), a.cx.Now()) }, MaxLines: 1,
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)},
			},
		},
		Children:   a.sessionMenuItems(s),
		PopupStyle: core.Style{MinWidth: core.Pt(200)},
		PopupStyleFunc: func() core.Style {
			return a.menuCard(a.cx)
		},
	}
}

// railFooter is the dock at the rail's bottom: settings, announcements,
// feedback, and the theme, as PiDeck keeps them.
func (a *app) railFooter() core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifySpaceBetween,
		Width: core.Pct(100), Padding: core.Edges{Left: 2, Right: 2}}, Children: []core.Node{
		hint("设置", ui.IconButton{Icon: lucide.Settings, Label: apptext.T("设置"), Size: 28, IconSize: 14.5,
			Selected: func() bool { return a.paneVisible() && a.activePane.Get() == paneSettings }, OnPress: a.openSettingsPane}),
		a.announceButton(),
		a.feedbackButton(),
		hint("切换外观", ui.IconButton{Icon: func() *core.SVG {
			if a.cx.Dark() {
				return lucide.Sun()
			}
			return lucide.Moon()
		}, Label: apptext.T("切换外观"), Size: 28, IconSize: 14.5, OnPress: a.cycleTheme}),
	}}
}
