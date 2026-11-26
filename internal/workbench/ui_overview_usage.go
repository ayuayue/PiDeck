//go:build !js && !android && !ios

package workbench

// The overview's numbers: how full the context window is and what the
// session has spent, both read from the sources the composer's ring panel
// reads.

import (
	"fmt"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// overviewResources keeps context pressure and session cost in one block.
func (a *app) overviewResources(s *session) core.Node {
	colors := ui.ColorsOf(a.cx)
	return overviewSection(colors, overviewLabel(colors, apptext.T("资源与用量")), a.overviewContext(s), a.overviewUsage(s))
}

// overviewContext is the window's meter: what the conversation holds, the
// room it has left, and the compaction once it fills. An unmeasured window
// stays out instead of showing a zero the backend never reported.
func (a *app) overviewContext(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		u := a.contextUseOf(s)
		if !u.Known {
			return nil
		}
		fill := u.fraction()
		head := overviewLabel(colors, apptext.T("上下文"),
			ui.Tabular(core.Text{Content: u.figures(), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)}),
			ui.Tabular(core.Text{Content: fmt.Sprintf("%.0f%%", u.Percent), MaxLines: 1,
				Style: core.Style{FontSize: 10.5, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)}))
		rows := []core.Node{overviewMeter(colors, func() float64 { return fill }, func() core.Color { return ringColor(colors, fill) })}
		// Compacting is worth a control only once the window is nearly full,
		// and never while a turn could still be reading it.
		if fill >= 0.75 && !s.busyNow() {
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter}, Children: []core.Node{
				core.View{Style: core.Style{FlexGrow: 1}},
				overviewAction(colors, apptext.T("压缩上下文"), "overview-compact", func() { a.compact(s) }),
			}})
		}
		return core.View{Style: core.Style{Gap: 8}, Children: append([]core.Node{head}, rows...)}
	})
}

// overviewUsage is what the session spent, as the four numbers that say how
// heavy the conversation was, plus the calls behind them.
func (a *app) overviewUsage(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = s.uiSeq.Get()
		colors := ui.ColorsOf(cx)
		spend := a.spendOf(s)
		if spend.Input == 0 && spend.Output == 0 && spend.Cost <= 0 {
			return ui.Text(apptext.T("还没有用量"), 12, ui.Regular, colors.Muted)
		}
		tile := func(label, value string) core.Node {
			return core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), Gap: 1, CornerRadius: ui.RadiusControl,
				Padding: core.Edges{Top: 5, Right: 8, Bottom: 6, Left: 8}, Background: colors.Inset()}, Children: []core.Node{
				ui.Text(label, 12, ui.Regular, colors.Muted),
				ui.Tabular(core.Text{Content: value, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 16, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)}),
			}}
		}
		grid := func(left, right core.Node) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: []core.Node{left, right}}
		}
		st := s.stats.Get()
		_, tools := sessionCounts(s, st)
		counts := ui.Textf(func() string {
			return fmt.Sprintf("%s %d · %s %s", apptext.T("工具调用"), tools, apptext.T("缓存读"), viewkit.Tokens(spend.CacheRead))
		}, 10, ui.Regular, colors.Faint)
		open := s.toolOpen("overview:usage", false)
		label := apptext.T("展开")
		if open {
			label = apptext.T("收起")
		}
		return core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
			grid(tile(apptext.T("费用"), viewkit.Credits(spend.Cost)), tile(apptext.T("工具调用"), fmt.Sprint(tools))),
			overviewLabel(colors, apptext.T("用量"), overviewAction(colors, label, "overview-usage-toggle", func() { s.toggleOpen("overview:usage") })),
			core.Show{When: func() bool { return open }, Then: func(*core.Scope) core.Node {
				return core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
					grid(tile(apptext.T("输入"), viewkit.Tokens(spend.Input)), tile(apptext.T("输出"), viewkit.Tokens(spend.Output))),
					grid(tile(apptext.T("缓存命中"), cacheShareText(s.perf.Get())), tile(apptext.T("缓存读"), viewkit.Tokens(spend.CacheRead))), counts,
				}}
			}},
		}}
	})
}
