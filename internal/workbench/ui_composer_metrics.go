//go:build !js && !android && !ios

package workbench

// The composer footer's line of numbers: how many turns the session holds,
// how long its reply took and how fast it wrote, what the cache served, and
// what the session has spent. The ring's panel explains the same figures;
// this row is the one that needs no click. Each group can be turned off,
// both from the row's own menu and from 外观 in the settings; the choice is
// one config value, the source of truth for the row.

import (
	"fmt"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// composerMetric is one group of the footer's line: the config value that
// turns it on, and the words the menu and the settings call it.
type composerMetric struct {
	ID    string
	Label string
	Note  string
	Icon  func() *core.SVG
}

// composerMetrics is the order the row draws its groups in, and the order
// the customization menu and the settings offer them.
var composerMetrics = []composerMetric{
	{ID: "turns", Label: "轮次", Note: "这个会话已经完成的轮数", Icon: lucide.ListOrdered},
	{ID: "reply", Label: "回复速度", Note: "回复用了多久，流式与平均速度", Icon: lucide.Timer},
	{ID: "cache", Label: "缓存命中", Note: "提问里由缓存提供的部分", Icon: lucide.Database},
	{ID: "tokens", Label: "输入与输出", Note: "会话累计读入与写出的 token", Icon: lucide.Hash},
	{ID: "context", Label: "上下文占用", Note: "上下文窗口用掉多少", Icon: lucide.CircleGauge},
	{ID: "cost", Label: "费用", Note: "会话累计花费", Icon: lucide.Coins},
}

// composerMetricsDefault is what the footer shows before the user picks:
// the four groups PiDeck's own strip carries.
const composerMetricsDefault = "turns,reply,cache,tokens"

// composerMetricsNone is a spec with every group turned off.
const composerMetricsNone = "none"

// parseComposerMetrics reads a stored spec; an empty one is the default
// set, and unknown names are ignored.
func parseComposerMetrics(spec string) map[string]bool {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		spec = composerMetricsDefault
	}
	on := make(map[string]bool, len(composerMetrics))
	if spec == composerMetricsNone {
		return on
	}
	for _, part := range strings.Split(spec, ",") {
		on[strings.TrimSpace(part)] = true
	}
	return on
}

// composerMetricsSpec writes a set back in the drawing order, and "none"
// when nothing is left on.
func composerMetricsSpec(on map[string]bool) string {
	parts := make([]string, 0, len(composerMetrics))
	for _, m := range composerMetrics {
		if on[m.ID] {
			parts = append(parts, m.ID)
		}
	}
	if len(parts) == 0 {
		return composerMetricsNone
	}
	return strings.Join(parts, ",")
}

// normalizeComposerMetrics rewrites a hand-edited spec into the form the
// row reads: unknown names dropped, the rest in order. An empty spec keeps
// meaning the default set, so it stays empty.
func normalizeComposerMetrics(spec string) string {
	if strings.TrimSpace(spec) == "" {
		return ""
	}
	return composerMetricsSpec(parseComposerMetrics(spec))
}

// toggleComposerMetric flips one group in a spec.
func toggleComposerMetric(spec, id string) string {
	on := parseComposerMetrics(spec)
	on[id] = !on[id]
	return composerMetricsSpec(on)
}

// setComposerMetrics stores the spec in the signal the row reads, in the
// config, and in the file.
func (a *app) setComposerMetrics(spec string) {
	if a.footerMetrics.GetUntracked() == spec {
		return
	}
	a.footerMetrics.Set(spec)
	a.cfg.FooterMetrics = spec
	if a.st != nil {
		a.st.edit(func(c *config) { c.FooterMetrics = spec })
	}
}

// toggleComposerMetricGroup turns one group on or off and remembers it.
func (a *app) toggleComposerMetricGroup(id string) {
	a.setComposerMetrics(toggleComposerMetric(a.footerMetrics.GetUntracked(), id))
}

// composerMetricsNode is the footer's line of numbers, with the menu that
// chooses which of them show.
//
// The numbers are a Dynamic of their own: a running reply rewrites them at
// the flush rate, and the spinner beside them stays mounted, so it turns
// instead of starting over with every flush.
func (a *app) composerMetricsNode(s *session) core.Node {
	trigger := core.View{
		OnPress: func(core.PressEvent) { a.metricsOpen.Update(func(v bool) bool { return !v }) },
		Role:    core.RoleButton, Label: apptext.T("输入框指标"), TestID: "composer-metrics",
		StyleFunc: func() core.Style {
			colors := ui.ColorsOf(a.cx)
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, FlexShrink: 1, MinWidth: core.Pt(0),
				Height: core.Pt(20), Padding: core.Symmetric(0, 6), CornerRadius: 6,
				Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(a.cx, 2)}
		},
		Children: []core.Node{
			core.Dynamic(func(cx *core.Scope) core.Node {
				colors := ui.ColorsOf(cx)
				var children []core.Node
				for i, group := range a.composerMetricGroups(s) {
					if i > 0 {
						children = append(children, core.View{Style: core.Style{Width: core.Pt(1), Height: core.Pt(9),
							FlexShrink: 0, Background: ui.Alpha(colors.Text(), 0.16)}})
					}
					children = append(children, core.Text{Content: group, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style:     core.Style{FontSize: 10, FlexShrink: 1, MinWidth: core.Pt(0)},
						StyleFunc: ui.Colored(colors.Faint)})
				}
				if len(children) == 0 {
					// Every group is off: the row keeps a small way back to the menu.
					children = []core.Node{ui.Icon(lucide.ChartNoAxesColumn, 11, colors.Faint),
						ui.Text(apptext.T("指标"), 10, ui.Regular, colors.Faint)}
				}
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7,
					FlexShrink: 1, MinWidth: core.Pt(0)}, Children: children}
			}),
			core.Show{When: s.busy, Then: func(*core.Scope) core.Node { return ui.Spinner{Size: 9} }},
		},
	}
	return a.popoverCard(a.metricsOpen, core.PlaceTop, core.AlignEnd, 244,
		hintOf(func() string { return apptext.T("点一下选择显示哪些数字") }, trigger),
		func(cx *core.Scope) core.Node {
			on := parseComposerMetrics(a.footerMetrics.Get())
			rows := []core.Node{composerPanelTitle(cx, apptext.T("底部指标"))}
			for _, m := range composerMetrics {
				metric := m
				row := composerRow(cx, metric.Icon, apptext.T(metric.Label), apptext.T(metric.Note),
					on[metric.ID], false, func() { a.toggleComposerMetricGroup(metric.ID) })
				row.TestID = "composer-metric-" + metric.ID
				rows = append(rows, row)
			}
			return core.View{Style: core.Style{Gap: 1}, Children: rows}
		}, "composer-metrics-menu")
}

// composerMetricGroups is the text of every enabled group, in the order the
// row draws them. A group with nothing to say (no reply yet, nothing spent)
// is left out, so a new session shows one quiet number instead of dashes.
func (a *app) composerMetricGroups(s *session) []string {
	on := parseComposerMetrics(a.footerMetrics.Get())
	st := s.stats.Get()
	perf := s.perf.Get()
	spend := a.spendOf(s)
	var groups []string
	if on["turns"] {
		turns, _ := sessionCounts(s, st)
		groups = append(groups, apptext.T("%d 轮", turns))
	}
	if on["reply"] {
		if text, ok := a.composerReplyGroup(s, perf); ok {
			groups = append(groups, text)
		}
	}
	if on["cache"] && perf.HasHit {
		groups = append(groups, apptext.T("缓存命中 %.0f%%", perf.HitLast))
	}
	if on["tokens"] && (spend.Input > 0 || spend.Output > 0) {
		groups = append(groups, apptext.T("输入 %s tok · 输出 %s tok", viewkit.Tokens(spend.Input), viewkit.Tokens(spend.Output)))
	}
	if on["context"] {
		if u := a.contextUseOf(s); u.Known {
			groups = append(groups, apptext.T("上下文 %.0f%%", u.Percent))
		}
	}
	if on["cost"] && spend.Cost > 0 {
		groups = append(groups, apptext.T("费用 %s", viewkit.Credits(spend.Cost)))
	}
	return groups
}

// composerReplyGroup is the reply's clock and speeds: the one in flight
// while a turn runs, else the last one that finished. It stays away from a
// session that has not answered yet, where every field would be a dash.
func (a *app) composerReplyGroup(s *session, perf replyPerf) (string, bool) {
	now := a.cx.Now()
	var took time.Duration
	switch {
	case s.busy() && !s.replyStart.IsZero():
		took = now.Sub(s.replyStart)
	case perf.HasReplySpeed:
		took = perf.Total
	}
	if took <= 0 {
		return "", false
	}
	live := "—"
	if s.busy() {
		if rate := liveReplyRate(s, now); rate > 0 {
			live = fmt.Sprintf("%.0f tok/s", rate)
		}
	}
	mean := "—"
	if rate := perf.rate(); rate > 0 {
		mean = fmt.Sprintf("%.0f tok/s", rate)
	}
	return apptext.T("回复 %s · 流式 %s · 均速 %s", paceDuration(took), live, mean), true
}

// liveReplyRate is how fast the reply in flight is writing, from the text it
// has shown: a token per four bytes, which is close for both Latin text and
// CJK, where three bytes carry about a token.
func liveReplyRate(s *session, now time.Time) float64 {
	if s.replyStart.IsZero() {
		return 0
	}
	tokens := float64(len(s.streamText.Get())) / 4
	seconds := now.Sub(s.replyStart).Seconds()
	if tokens < 1 || seconds <= 0 {
		return 0
	}
	return tokens / seconds
}

// composerMetricChips is 外观's row of the same choices: one chip per
// group, lit while the footer shows it.
func (a *app) composerMetricChips() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		on := parseComposerMetrics(a.footerMetrics.Get())
		var chips []core.Node
		for _, m := range composerMetrics {
			metric := m
			off := func() bool { return !on[metric.ID] }
			chips = append(chips, core.View{
				OnPress: func(core.PressEvent) { a.toggleComposerMetricGroup(metric.ID) },
				Role:    core.RoleCheckbox, Label: apptext.T(metric.Label), Checked: func() bool { return !off() },
				TestID: "footer-metric-" + metric.ID,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(24),
						Padding: core.Symmetric(0, 9), CornerRadius: 12, BorderWidth: 1, BorderColor: colors.Border(),
						Hover: &core.Style{Background: colors.Hover()}}
					if !off() {
						st.Background = colors.Pressed()
						st.BorderColor = colors.Text()
					}
					return st
				},
				Children: []core.Node{ui.Text(apptext.T(metric.Label), 11.5, ui.Regular, colors.Text)},
			})
		}
		return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 5, MaxWidth: core.Pt(340),
			JustifyContent: core.JustifyEnd}, Children: chips}
	})
}
