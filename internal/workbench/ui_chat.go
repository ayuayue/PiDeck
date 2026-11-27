//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// The reading width of the transcript and composer, as a share of the
// chat area: a narrower column reads better on wide screens, and 100% is
// all of it.
const (
	chatWidthPctMin     = 50
	chatWidthPctMax     = 100
	chatWidthPctDefault = 80
	chatSidePadding     = 20
	chatColumnMin       = 360
)

// A session tab's width, as a share of the window: narrow enough that
// several fit, wide enough that a real title reads. The minimum keeps a
// short title from being clipped to nothing.
const (
	tabWidthPctMin     = 8
	tabWidthPctMax     = 30
	tabWidthPctDefault = 22
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
			return core.View{StyleFunc: func() core.Style {
				// PiDeck's paper canvas sits between the white cards and rail;
				// derive it from the palette so custom themes keep their hue.
				return ui.FillRest.Merge(core.Style{Background: ui.Mix(colors.Surface(), colors.Inset(), 0.45), Color: colors.Text()})
			}, Children: []core.Node{
				a.chatSurface(cx, s, selection),
				a.turnAxis(s),
				core.Show{When: a.chatFindOpen.Get, Then: func(cx *core.Scope) core.Node { return a.chatFindBar(s) }},
				core.Show{When: func() bool {
					return len(s.turns.Get()) == 0 && !s.loaded.Get() && s.status.Get() != statusFailed
				}, Then: func(cx *core.Scope) core.Node { return a.historySkeleton(s) }},
			}}
		}),
	}}
}

// chatColumnWidth eases the width limit when split panels leave less room
// for the transcript and input. Both still fit inside the chat surface.
func (a *app) chatColumnWidth(surface core.Points) core.Length {
	pct := float32(a.chatWidthPct())
	available := surface - 2*chatSidePadding
	if available <= 0 {
		return core.Pct(pct)
	}
	return core.Pct(min(100, max(pct, float32(100*chatColumnMin)/float32(available))))
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

// setChatWidthPct narrows or widens the transcript and composer; the
// default is stored as unset. The views read the signal, so they follow a
// drag at once, and only the file write waits for the value to rest.
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
	if a.st == nil {
		return
	}
	a.st.change(func(c *config) { c.ChatWidthPct = stored })
	a.chatWidthSeq++
	seq := a.chatWidthSeq
	a.cx.AfterFunc(300*time.Millisecond, func() {
		if a.chatWidthSeq != seq || a.st == nil {
			return // still moving: the last value will be kept
		}
		a.saveConfigAsync()
	})
}

// tabWidthPct is one session tab's share of the window, the default until
// the user narrows or widens it.
func (a *app) tabWidthPct() int {
	pct := a.tabWidthPctSig.Get()
	if pct < tabWidthPctMin || pct > tabWidthPctMax {
		pct = tabWidthPctDefault
	}
	return pct
}

// tabWidth is a session tab's own width limit: a share of the window, with
// a floor so a narrow window does not squeeze a title to nothing. Read on
// the scope that draws the tab, so a window resize follows.
func (a *app) tabWidth(cx *core.Scope) core.Length {
	return core.Pt(tabWidthPoints(cx.Env().Window().Width, a.tabWidthPct()))
}

// tabWidthPoints is the width a share of a window works out to, with the
// floor that keeps a short title from being clipped to nothing.
func tabWidthPoints(window core.Points, pct int) core.Points {
	if window <= 0 {
		window = 1200
	}
	width := core.Points(float32(window) * float32(pct) / 100)
	if width < 96 {
		return 96
	}
	return width
}

// setTabWidthPct narrows or widens the session tabs; the default is stored
// as unset. The views read the signal, so they follow a drag at once, and
// only the file write waits for the value to rest.
func (a *app) setTabWidthPct(pct int) {
	if pct < tabWidthPctMin {
		pct = tabWidthPctMin
	}
	if pct > tabWidthPctMax {
		pct = tabWidthPctMax
	}
	a.tabWidthPctSig.Set(pct)
	stored := pct
	if pct == tabWidthPctDefault {
		stored = 0
	}
	a.cfg.TabWidthPct = stored
	if a.st == nil {
		return
	}
	a.st.change(func(c *config) { c.TabWidthPct = stored })
	a.tabWidthSeq++
	seq := a.tabWidthSeq
	a.cx.AfterFunc(300*time.Millisecond, func() {
		if a.tabWidthSeq != seq || a.st == nil {
			return // still moving: the last value will be kept
		}
		a.saveConfigAsync()
	})
}

// composerStack keeps the composer and its bars at the reading width.
func (a *app) composerStack(s *session, width func() core.Length, height func() core.Points, editor *core.Ref) core.Node {
	return core.View{Style: core.Style{Width: core.Pct(100), AlignItems: core.AlignCenter}, Children: []core.Node{
		core.View{TestID: "composer-column", Style: core.Style{Width: core.Pct(100), MinWidth: core.Pt(0)},
			StyleFunc: func() core.Style { return core.Style{MaxWidth: width()} }, Children: []core.Node{
				a.trustBar(s), a.goalStrip(s), a.todoBar(s), a.subagentComposerBar(s),
				// An ask takes the composer's place while it waits: the answer
				// is the only thing to send then.
				core.Show{
					When: func() bool { return s.showingAsk() != nil },
					Then: func(*core.Scope) core.Node { return a.askPanel(s) },
					Else: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Gap: 0}, Children: []core.Node{a.queuePanel(s, editor), a.draftChangeBar(s), a.composer(s, editor, height)}}
					},
				},
			}},
	}}
}

// transcript is the keyed list of turns, bounded to a window of the newest.
func (a *app) transcript(s *session, selection *chatSelection, width func() core.Length) core.Node {
	return core.View{Style: core.Style{MinWidth: core.Pt(0), FlexShrink: 0, Width: core.Pct(100), AlignItems: core.AlignCenter}, Children: []core.Node{
		core.View{Selectable: true, Ref: &selection.area, OnTextSelection: selection.changed, TestID: "transcript-column",
			OnMouseMove: selection.moved, OnMouseUp: selection.released,
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
					}, Children: []core.Node{a.turnView(s, t, ix, selection)}}
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
