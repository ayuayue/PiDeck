//go:build !js && !android && !ios

package workbench

// The composer's context ring and the panel it opens: how full the context
// window is, what the session has spent, how fast the last reply came and
// how much of it the cache served. Every number comes from one source:
// pi's session stats, the messages whose usage pi reports, and the app's
// own reply clock for the figures pi does not send.

import (
	"fmt"
	"math"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// contextPanelWidth is the panel's width: wide enough for a label and a
// tabular value on one line.
const contextPanelWidth = 300

// contextUse is how full the context window is. Pi reports both the tokens
// it holds and the window they fit in; without that, the last prompt and
// the model's own window stand in, so the ring is never a guess about
// totals the session has spent.
type contextUse struct {
	Tokens  int
	Window  int
	Percent float64
	Known   bool
}

// fraction is the share the ring fills, 0 when nothing is known.
func (c contextUse) fraction() float64 {
	if !c.Known || c.Window <= 0 {
		return 0
	}
	return float64(c.Tokens) / float64(c.Window)
}

// reading says what the ring shows, in words.
func (c contextUse) reading() string {
	if !c.Known {
		return apptext.T("上下文未测量")
	}
	return apptext.T("上下文已用 %.0f%%", c.Percent)
}

// figures is the two numbers behind the ring.
func (c contextUse) figures() string {
	if !c.Known {
		return apptext.T("未测量")
	}
	return fmt.Sprintf("%s / %s", viewkit.Tokens(c.Tokens), viewkit.Tokens(c.Window))
}

// contextUseOf reads the ring's value.
func (a *app) contextUseOf(s *session) contextUse {
	st := s.stats.Get()
	perf := s.perf.Get()
	if st.ContextWindow > 0 {
		percent := st.ContextPercent
		if percent <= 0 && st.ContextTokens > 0 {
			percent = float64(st.ContextTokens) * 100 / float64(st.ContextWindow)
		}
		return contextUse{Tokens: st.ContextTokens, Window: st.ContextWindow, Percent: percent, Known: true}
	}
	m := s.model.Get()
	if m.ContextWindow > 0 && perf.LastPrompt > 0 {
		tokens := perf.LastPrompt
		return contextUse{Tokens: tokens, Window: m.ContextWindow,
			Percent: float64(tokens) * 100 / float64(m.ContextWindow), Known: true}
	}
	return contextUse{}
}

// ringColor is the ring's ink: the accent, then a warning, then an alert as
// the window fills.
func ringColor(colors ui.Colors, fraction float64) core.Color {
	switch {
	case fraction >= 0.95:
		return colors.Danger()
	case fraction >= 0.8:
		return colors.Warn()
	}
	return colors.Text()
}

// contextRing is the composer's ring: a 14-point gauge that opens the usage
// panel. It stays a ring when nothing is measured, as PiDeck's does, so the
// control does not appear and vanish with a model switch.
func (a *app) contextRing(s *session, open *core.Signal[bool]) core.Node {
	use := func() contextUse { return a.contextUseOf(s) }
	return core.View{
		OnPress: func(core.PressEvent) { open.Update(func(v bool) bool { return !v }) },
		Role:    core.RoleButton, LabelFunc: func() string { return use().reading() }, TestID: "context-meter",
		StyleFunc: func() core.Style {
			colors := ui.ColorsOf(a.cx)
			return core.Style{Width: core.Pt(24), Height: core.Pt(24), CornerRadius: 12, FlexShrink: 0,
				AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
				Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(a.cx, 2)}
		},
		Children: []core.Node{core.Canvas{
			Style: core.Style{Width: core.Pt(14), Height: core.Pt(14)},
			Draw: func(d *core.Drawing, size core.Size) {
				colors := ui.ColorsOf(a.cx)
				u := use()
				const stroke = 2
				r := (float32(size.Width) - stroke) / 2
				x, y := float32(size.Width)/2, float32(size.Height)/2
				d.SetLineWidth(stroke)
				d.BeginPath().Arc(x, y, r, 0, 2*math.Pi, false).SetStrokeColor(ui.Alpha(colors.Text(), 0.14)).Stroke()
				f := math.Min(1, u.fraction())
				if f <= 0 {
					return
				}
				start := float32(-math.Pi / 2)
				d.BeginPath().Arc(x, y, r, start, start+float32(f)*2*math.Pi, false).
					SetStrokeColor(ringColor(colors, u.fraction())).Stroke()
			},
		}},
	}
}

// contextPanel is the ring's panel: the window, what the session spent, the
// last reply's pace, and the actions that follow.
func (a *app) contextPanel(s *session, close func()) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		u := a.contextUseOf(s)
		st := s.stats.Get()
		spend := a.spendOf(s)
		perf := s.perf.Get()
		row := func(label, value string) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, Height: core.Pt(24)},
				Children: []core.Node{
					core.Text{Content: label, MaxLines: 1, Style: core.Style{FontSize: 12, FlexShrink: 0},
						StyleFunc: ui.Colored(colors.Muted)},
					core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}},
					core.Text{Content: value, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11.5, FlexShrink: 0},
						StyleFunc: ui.Colored(colors.Text)},
				}}
		}
		section := func(title string, rows ...core.Node) core.Node {
			return core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Top: 8}, Borders: core.Edges{Top: 1}},
				StyleFunc: func() core.Style { return core.Style{BorderColors: core.EdgeColors{Top: colors.Line()}} },
				Children: append([]core.Node{core.Text{Content: title,
					Style: core.Style{FontSize: 10, FontWeight: ui.Semibold, LetterSpacing: 0.4}, StyleFunc: ui.Colored(colors.Faint)}}, rows...)}
		}
		fill := u.fraction()
		bar := core.View{Style: core.Style{Height: core.Pt(5), CornerRadius: 2.5, Background: ui.Alpha(colors.Text(), 0.10),
			Overflow: core.Hidden}, Children: []core.Node{core.View{
			StyleFunc: func() core.Style {
				return core.Style{Width: core.Pct(float32(math.Min(1, fill) * 100)), Height: core.Pt(5), Background: ringColor(colors, fill)}
			}}}}
		children := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Edges{Bottom: 4}}, Children: []core.Node{
				core.Text{ContentFunc: u.reading, MaxLines: 1, Style: core.Style{FontSize: 12.5, FontWeight: ui.Semibold},
					StyleFunc: ui.Colored(colors.Text)},
				core.View{Style: core.Style{FlexGrow: 1}},
				core.Text{ContentFunc: u.figures, MaxLines: 1, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11},
					StyleFunc: ui.Colored(colors.Faint)},
			}},
			bar,
		}
		// Tokens the session has spent: what pi counts, not what the window
		// holds, so a long session reads as its own total. A backend that
		// reports no usage at all keeps the section away instead of zeroes.
		if spend.Total > 0 || spend.Cost > 0 || spend.Input > 0 {
			children = append(children, section(apptext.T("用量"),
				row(apptext.T("输入 / 输出"), fmt.Sprintf("%s / %s", viewkit.Tokens(spend.Input), viewkit.Tokens(spend.Output))),
				row(apptext.T("缓存读 / 写"), fmt.Sprintf("%s / %s", viewkit.Tokens(spend.CacheRead), viewkit.Tokens(spend.CacheWrite))),
				row(apptext.T("缓存命中"), cacheShareText(perf)),
				row(apptext.T("费用"), viewkit.Credits(spend.Cost)),
			))
		}
		pace := []core.Node{}
		if perf.HasTTFT {
			pace = append(pace, row(apptext.T("首字"), paceDuration(perf.TTFT)))
		}
		if perf.HasReplySpeed && perf.Total > 0 {
			pace = append(pace, row(apptext.T("这次回复"), paceDuration(perf.Total)))
		}
		if rate := perf.rate(); rate > 0 {
			pace = append(pace, row(apptext.T("速度"), fmt.Sprintf("%.1f tok/s", rate)))
		}
		if len(pace) > 0 {
			children = append(children, section(apptext.T("最近一次回复"), pace...))
		}
		turns, tools := sessionCounts(s, st)
		counts := []core.Node{row(apptext.T("轮次 / 工具"), fmt.Sprintf("%d / %d", turns, tools))}
		if st.Known {
			counts = append(counts, row(apptext.T("消息"), fmt.Sprintf("%d / %d", st.UserMessages, st.AssistantMessages)))
		}
		children = append(children, section(apptext.T("这个会话"), counts...))
		children = append(children, core.View{Style: core.Style{Direction: core.Row, Gap: 6, Padding: core.Edges{Top: 10}}, Children: []core.Node{
			ui.Button{Text: apptext.T("压缩上下文"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "usage-compact",
				Disabled: func() bool { return s.busyNow() }, OnPress: func() {
					close()
					a.compact(s)
				}},
			ui.Button{Text: apptext.T("会话面板"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "usage-drawer",
				OnPress: func() {
					close()
					a.drawer.Set(true)
					a.setDrawerTab("overview")
				}},
		}})
		return core.View{TestID: "usage-panel", Style: core.Style{Width: core.Pt(contextPanelWidth), Gap: 2}, Children: children}
	})
}

// spendOf is what the session has spent. Pi's own totals win: they are
// what its footer counts, and a branched or resumed session can differ from
// the messages on screen. The transcript's sum stands in before pi answers,
// and its cost fills in a total pi left without one.
func (a *app) spendOf(s *session) usageInfo {
	st := s.stats.Get()
	transcript := s.usage.Get()
	if st.Known && st.Tokens.Total > 0 {
		if st.Tokens.Cost == 0 {
			st.Tokens.Cost = transcript.Cost
		}
		return st.Tokens
	}
	return transcript
}

// sessionCounts is how many turns and calls the session holds: pi's own
// count once it answered, the transcript's before that.
func sessionCounts(s *session, st sessionStats) (turns, tools int) {
	if st.Known {
		return st.UserMessages, st.ToolCalls
	}
	for _, t := range s.turns.Get() {
		turns++
		tools += t.Tools
	}
	return turns, tools
}

// hitText is the cache's share of the prompts: the last reply's, and the
// mean over the session.
func cacheShareText(perf replyPerf) string {
	if !perf.HasHit {
		return apptext.T("未上报")
	}
	if avg := perf.averageHit(); perf.HitCount > 1 && avg >= 0 {
		return fmt.Sprintf("%.1f%% · %s %.1f%%", perf.HitLast, apptext.T("平均"), avg)
	}
	return fmt.Sprintf("%.1f%%", perf.HitLast)
}

// paceDuration is a short duration with a fine first step: a first token
// arrives in milliseconds, a reply takes seconds.
func paceDuration(d time.Duration) string {
	switch {
	case d <= 0:
		return "—"
	case d < time.Second:
		return fmt.Sprintf("%dms", d.Milliseconds())
	case d < time.Minute:
		return fmt.Sprintf("%.1fs", d.Seconds())
	}
	return duration(d)
}

// usageHint is the ring's hover text.
func (a *app) usageHint(s *session) func() string {
	return func() string {
		u := a.contextUseOf(s)
		return u.reading() + " · " + u.figures()
	}
}
