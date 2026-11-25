//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// started reports whether a session has an agent behind it: one that was
// opened in this run, so its tab says more than "never started".
func (s *session) started() bool {
	return s.engine != nil || s.acp != nil || s.readySig.Get() || s.status.Get() != statusIdle
}

// statusDot is a session's dot, the same everywhere it is listed: grey
// before it starts, blue once its agent is up with no turn in flight,
// amber while a turn or an approval is, and red when it failed.
func statusDot(colors ui.Colors, s *session) core.Color {
	if s == nil {
		return colors.Faint()
	}
	switch s.status.Get() {
	case statusFailed:
		return colors.Danger()
	case statusStarting, statusRunning, statusWaiting:
		return viewkit.Working
	}
	if s.started() {
		return viewkit.Idle
	}
	return colors.Faint()
}

// sessionRowOpts is how the rail draws one session row when the list nests:
// how many sessions grew out of this one, whether they show, and whether
// the list reserves the toggle's room on rows that have none.
type sessionRowOpts struct {
	kids    int
	open    func() bool
	toggle  func()
	reserve bool
}

// sessionRowWith is one session in the rail, with the disclosure of the
// sessions below it when the list nests.
func (a *app) sessionRowWith(s func() *session, opts sessionRowOpts) core.Node {
	colors := ui.ColorsOf(a.cx)
	selected := func() bool { return a.activeID.Get() == s().ID }
	lead := func() []core.Node {
		if !opts.reserve {
			return nil
		}
		return []core.Node{a.sessionToggle(s, opts)}
	}
	return base.ContextMenu{
		Trigger: core.View{
			OnPress: func(core.PressEvent) { a.selectSession(s()) },
			Role:    core.RoleButton, LabelFunc: func() string { return s().title.Get() }, TestID: "session-row",
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(32), Padding: core.Symmetric(0, 8),
					CornerRadius: 7, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				if selected() {
					st.Background = colors.Pressed()
				}
				return st
			},
			Children: append(lead(), []core.Node{
				core.View{TestID: "session-status-" + s().ID, StyleFunc: func() core.Style {
					return core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3,
						Background: statusDot(colors, s()), FlexShrink: 0}
				}},
				core.Text{ContentFunc: func() string { return s().title.Get() }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 13.5, LineHeight: 19},
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
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)},
			}...),
		},
		Children:   a.sessionMenuItems(s),
		PopupStyle: core.Style{MinWidth: core.Pt(200)},
		PopupStyleFunc: func() core.Style {
			return a.menuCard(a.cx)
		},
	}
}

// sessionToggle is the rail's disclosure: a chevron that opens the sessions
// that grew out of this one, and the room every row keeps when the list
// holds any.
func (a *app) sessionToggle(s func() *session, opts sessionRowOpts) core.Node {
	colors := ui.ColorsOf(a.cx)
	if opts.kids <= 0 {
		return core.View{Style: core.Style{Width: core.Pt(14), FlexShrink: 0}}
	}
	count := opts.kids
	return core.View{
		OnPress: func(core.PressEvent) {
			if opts.toggle != nil {
				opts.toggle()
			}
		},
		Role: core.RoleButton, LabelFunc: func() string { return railToggleLabel(count, opts.open != nil && opts.open()) },
		TestID: "session-toggle-" + s().ID,
		StyleFunc: func() core.Style {
			return core.Style{Width: core.Pt(14), Height: core.Pt(14), FlexShrink: 0,
				AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, CornerRadius: 3,
				Hover: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{ui.IconOf(func() *core.SVG {
			if opts.open != nil && opts.open() {
				return lucide.ChevronDown()
			}
			return lucide.ChevronRight()
		}, 11, colors.Faint)},
	}
}

// railFooter is the dock at the rail's bottom: settings, announcements,
// feedback, and the theme, as PiDeck keeps them.
func (a *app) railFooter() core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifySpaceBetween,
		Width: core.Pct(100), Padding: core.Edges{Left: 2, Right: 2}}, Children: []core.Node{
		hint("设置", ui.IconButton{Icon: lucide.Settings, Label: apptext.T("设置"), Size: 30, IconSize: 15.5,
			Selected: func() bool { return a.paneVisible() && a.activePane.Get() == paneSettings }, OnPress: a.openSettingsPane}),
		a.announceButton(),
		a.feedbackButton(),
		hint("切换外观", ui.IconButton{Icon: func() *core.SVG {
			if a.cx.Dark() {
				return lucide.Sun()
			}
			return lucide.Moon()
		}, Label: apptext.T("切换外观"), Size: 30, IconSize: 15.5, OnPress: a.cycleTheme}),
	}}
}
