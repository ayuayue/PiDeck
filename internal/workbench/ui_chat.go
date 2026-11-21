//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// The reading width of the transcript and composer, as a share of the
// window: a narrower column reads better on wide screens, and the upper
// bound keeps the chat from filling the window edge to edge.
const (
	chatWidthPctMin     = 50
	chatWidthPctMax     = 90
	chatWidthPctDefault = 80
	chatSidePadding     = 20
	chatColumnMin       = 360
)

// chatPane is the conversation and its composer.
func (a *app) chatPane() core.Node {
	return core.View{Style: ui.FillRest, Children: []core.Node{
		core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			s := a.active()
			if s == nil {
				return a.welcome()
			}
			selection := newChatSelection(cx)
			width := core.NewSignal(cx, core.Points(0))
			return core.View{StyleFunc: func() core.Style {
				// PiDeck's paper canvas sits between the white cards and rail;
				// derive it from the palette so custom themes keep their hue.
				return ui.FillRest.Merge(core.Style{Background: ui.Mix(colors.Surface(), colors.Inset(), 0.45), Color: colors.Text()})
			}, Children: []core.Node{
				a.chatSurface(s, selection, width),
				a.turnAxis(s),
				core.Show{When: a.chatFindOpen.Get, Then: func(cx *core.Scope) core.Node { return a.chatFindBar(s) }},
				core.Show{When: func() bool {
					return len(s.turns.Get()) == 0 && !s.loaded.Get() && s.status.Get() != statusFailed
				}, Then: func(cx *core.Scope) core.Node { return a.historySkeleton(s) }},
				core.Show{When: func() bool {
					return len(s.turns.Get()) == 0 && (s.loaded.Get() || s.status.Get() == statusFailed)
				}, Then: func(cx *core.Scope) core.Node { return a.emptyChat(s) }},
			}}
		}),
	}}
}

// chatColumnWidth eases the width limit when split panels leave less room
// for the transcript and input. Both still fit inside the chat surface.
func (a *app) chatColumnWidth(surface core.Points) core.Length {
	pct := float32(a.chatWidthPct())
	if available := surface - 2*chatSidePadding; available > 0 {
		pct = min(100, max(pct, float32(100*chatColumnMin)/float32(available)))
	}
	return core.Pct(pct)
}

// chatWidthPct is the transcript and composer's share of the window, the
// default until the user narrows or widens it.
func (a *app) chatWidthPct() int {
	pct := a.chatWidthPctSig.Get()
	if pct < chatWidthPctMin || pct > chatWidthPctMax {
		pct = chatWidthPctDefault
	}
	return pct
}

// dialogWidth is a modal's width: the same share of the window as the
// chat column.
func (a *app) dialogWidth() core.Length {
	return core.Pct(float32(a.chatWidthPct()))
}

// setChatWidthPct narrows or widens the transcript and composer, and
// keeps the choice; the default is stored as unset.
func (a *app) setChatWidthPct(pct int) {
	if pct < chatWidthPctMin {
		pct = chatWidthPctMin
	}
	if pct > chatWidthPctMax {
		pct = chatWidthPctMax
	}
	a.chatWidthPctSig.Set(pct)
	stored := pct
	if pct == chatWidthPctDefault {
		stored = 0
	}
	a.cfg.ChatWidthPct = stored
	if a.st != nil {
		a.st.edit(func(c *config) { c.ChatWidthPct = stored })
	}
}

// composerStack keeps the composer and its bars at the reading width.
func (a *app) composerStack(s *session, width func() core.Length) core.Node {
	return core.View{Style: core.Style{Width: core.Pct(100), AlignItems: core.AlignCenter}, Children: []core.Node{
		core.View{TestID: "composer-column", Style: core.Style{Width: core.Pct(100), MinWidth: core.Pt(0)},
			StyleFunc: func() core.Style { return core.Style{MaxWidth: width()} }, Children: []core.Node{
				a.trustBar(s), a.goalStrip(s), a.todoBar(s),
				// An ask takes the composer's place while it waits: the answer
				// is the only thing to send then.
				core.Show{
					When: func() bool { return s.showingAsk() != nil },
					Then: func(*core.Scope) core.Node { return a.askPanel(s) },
					Else: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Gap: 0}, Children: []core.Node{a.queuePanel(s), a.draftChangeBar(s), a.composer(s)}}
					},
				},
			}},
	}}
}

// transcript is the keyed list of turns, bounded to a window of the newest.
func (a *app) transcript(s *session, selection *chatSelection, width func() core.Length) core.Node {
	return core.View{Style: core.Style{MinWidth: core.Pt(0), FlexShrink: 0, Width: core.Pct(100), AlignItems: core.AlignCenter}, Children: []core.Node{
		core.View{Selectable: true, Ref: &selection.area, OnTextSelection: selection.changed, TestID: "transcript-column",
			Style:     core.Style{Width: core.Pct(100), MinWidth: core.Pt(0), Gap: 48},
			StyleFunc: func() core.Style { return core.Style{MaxWidth: width()} }, Children: []core.Node{
				core.Show{When: func() bool { return len(s.turns.Get()) > s.window.Get() }, Then: func(cx *core.Scope) core.Node {
					return a.loadEarlier(s)
				}},
				core.Each(func() []turn {
					turns := s.turns.Get()
					window := s.window.Get()
					start := max(0, len(turns)-window)
					list := turns[start:]
					if q := a.findQuery(); q != "" {
						kept := make([]turn, 0, len(list))
						for _, t := range list {
							if turnMatches(t, q) {
								kept = append(kept, t)
							}
						}
						list = kept
					}
					return list
				}, func(t turn) string { return t.ID }, func(cx *core.Scope, t func() turn, ix func() int) core.Node {
					// Each turn reports where it sits, so a mark on the ruler can
					// scroll to the turn it stands for.
					return core.View{OnLayout: func(b core.Bounds) {
						if s.tops == nil {
							s.tops = map[string]float64{}
						}
						s.tops[t().ID] = float64(b.Origin.Y)
					}, Children: []core.Node{a.turnView(s, t, ix)}}
				}),
			}},
	}}
}

// loadEarlier shows another page of older turns.
func (a *app) loadEarlier(s *session) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{Style: core.Style{AlignItems: core.AlignCenter, Padding: core.Edges{Top: 2}},
		Children: []core.Node{ui.Press{OnPress: func() {
			s.window.Update(func(n int) int { return n + 24 })
		}, Label: apptext.T("加载更早的对话"), Children: []core.Node{
			core.View{StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(28), Padding: core.Symmetric(0, 12),
					CornerRadius: 14, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
			}, Children: []core.Node{
				ui.Icon(lucide.ArrowUp, 12, colors.Muted),
				ui.Text(apptext.T("加载更早的对话"), 12, ui.Regular, colors.Muted),
			}},
		}}},
	}
}
