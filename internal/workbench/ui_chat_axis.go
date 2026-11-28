//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"fmt"
	"math"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// The ruler at the transcript's right edge: a scale of scroll positions,
// drawn across the middle of the height only, so it reads as a track
// without claiming the whole conversation.
const (
	// axisBand is the share of the height the ruler spans, centered.
	axisBand = 46
	// axisTickWidth is how long a tick grows to under the pointer, and
	// axisTickNarrow how long it rests.
	axisTickWidth  = 28
	axisTickNarrow = 12
	axisTickHeight = 4
	axisTickHit    = axisTickWidth + 4
	// axisStep is the most air one mark has above the next, and axisChrome
	// what the tab bar and padding take above the chat pane.
	axisStep   = 12
	axisChrome = 56
	// axisTickGapMin is the tightest pitch that still leaves a mark
	// pressable; closer than this, the ruler drops turns instead.
	axisTickGapMin = 8.0
)

// axisGrow eases a tick from its resting length to the long mark under the
// pointer; TransitionLayout is what animates a resize.
var axisGrow = core.Transition{Duration: 140 * time.Millisecond, Easing: core.EaseOut,
	Properties: core.TransitionLayout | core.TransitionBackground}

// planAxisTicks picks the turns that get a mark: one per turn while they fit,
// and otherwise an even sample that keeps the first and the last, so both
// ends of a long session stay a click away.
func planAxisTicks(turns int, bandHeight float64) []int {
	if turns <= 0 || bandHeight <= 0 {
		return nil
	}
	// Each mark needs a whole hit slot, including the first and last.
	fit := max(2, int(bandHeight/axisTickGapMin))
	if fit >= turns {
		marks := make([]int, turns)
		for i := range marks {
			marks[i] = i
		}
		return marks
	}
	marks := make([]int, 0, fit)
	for slot := 0; slot < fit; slot++ {
		marks = append(marks, int(math.Round(float64(slot)*float64(turns-1)/float64(fit-1))))
	}
	return marks
}

// turnAxis is the ruler at the transcript's right edge: one mark per turn
// across the middle of the height, a click scrolls to that turn, and resting
// on a mark names it.
func (a *app) turnAxis(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		turns := len(s.turns.Get())
		if turns < 3 {
			return nil
		}
		colors := ui.ColorsOf(cx)
		window := cx.Env().Window()
		pane := float64(window.Height) - axisChrome
		if pane <= 0 {
			return nil
		}
		bandHeight := pane * axisBand / 100
		shown := planAxisTicks(turns, bandHeight)
		// The marks keep a fixed pitch at most and stack as one compact
		// scale, centered in the band: four turns are four short marks
		// together, not four dashes spread over a third of the window. A
		// crowded ruler tightens the pitch instead of overflowing the band.
		pitch := math.Min(float64(axisStep), bandHeight/float64(max(1, len(shown))))
		box := core.Points(pitch)
		stack := core.Points(pitch * float64(len(shown)))
		marks := make([]core.Node, 0, len(shown)+1)
		for pos, turn := range shown {
			pos, turn := pos, turn
			bar := core.View{
				TestID:        fmt.Sprintf("axis-tick-%d", pos),
				PointerEvents: core.PointerEventsNone,
				StyleFunc: func() core.Style {
					// A short mark at rest; the one under the pointer grows out
					// to its full length, so the scale does not read as a picket
					// fence at rest.
					st := core.Style{Width: core.Pt(axisTickNarrow), Height: core.Pt(axisTickHeight), CornerRadius: axisTickHeight / 2,
						Background: colors.Faint()}
					if !a.reduceEffects.Get() && !ui.ReduceMotion(cx) {
						st.Transition = axisGrow
					}
					if a.axisHover.Get() == pos {
						st.Width = core.Pt(axisTickWidth)
						st.Background = colors.Text()
					}
					return st
				},
			}
			marks = append(marks, core.View{
				// The fixed hover slot owns presses; resizing the decorative
				// bar must not move or shrink the click target.
				OnPress:      func(core.PressEvent) { a.jumpToTurnIndex(s, turn) },
				Role:         core.RoleButton,
				LabelFunc:    func() string { return a.axisTip(s, turn) },
				OnMouseEnter: func(core.MouseEvent) { a.hoverAxis(pos) },
				// Leaving the box clears only its own tick, so moving from
				// one mark to the next keeps pointing at the new one
				// whichever of the two events arrives first.
				OnMouseLeave: func(core.MouseEvent) {
					if a.axisHover.GetUntracked() == pos {
						a.axisHover.Set(-1)
					}
				},
				Style: core.Style{Width: core.Pt(axisTickHit), Height: core.Pt(box), AlignItems: core.AlignCenter,
					JustifyContent: core.JustifyCenter}, Children: []core.Node{bar}})
		}
		marks = append(marks, a.axisHint(s, shown, box, pitch))
		inset := (pane - bandHeight) / 2
		top := inset + (bandHeight-float64(stack))/2
		return core.View{
			OnMouseLeave: func(core.MouseEvent) { a.axisHover.Set(-1) },
			Style: core.Style{Position: core.Absolute, Right: core.Pt(8), Width: core.Pt(axisTickHit), Height: core.Pt(stack),
				Direction: core.Column, AlignItems: core.AlignCenter, JustifyContent: core.JustifyStart,
				PointerEvents: core.PointerEventsBoxNone},
			StyleFunc: func() core.Style {
				return core.Style{Top: core.Pt(core.Points(top))}
			},
			Children: marks}
	})
}

// hoverAxis points the ruler's hint at a tick. Moving along the scale
// moves it at once; it eases in only when it was hidden, so sliding down
// the ruler does not blink.
func (a *app) hoverAxis(index int) {
	if a.axisHover.GetUntracked() == index {
		return
	}
	fresh := a.axisHover.GetUntracked() < 0
	a.axisHover.Set(index)
	if fresh {
		a.axisHintIn.Set(false)
		a.cx.AfterFunc(16*time.Millisecond, func() { a.axisHintIn.Set(true) })
	}
}

// axisHint is the summary beside the tick the pointer rests on: it sits
// just left of the ruler, on the tick's line, and takes no presses.
func (a *app) axisHint(s *session, shown []int, box core.Points, pitch float64) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		i := a.axisHover.Get()
		if i < 0 || i >= len(shown) {
			return nil
		}
		tip := a.axisTip(s, shown[i])
		if tip == "" {
			return nil
		}
		// The hint rides the tick's line inside the stack, so it never
		// drifts to another mark's height.
		centre := box/2 + core.Points(pitch*float64(i))
		top := math.Max(0, float64(centre)-14)
		return core.View{
			Style: core.Style{Position: core.Absolute, Right: core.Pt(axisTickHit + 8), Top: core.Pt(core.Points(top)),
				Width: core.Pt(260), Padding: core.Symmetric(6, 10), CornerRadius: 9, Background: colors.Surface(),
				BorderWidth: 1, BorderColor: colors.Border(), Shadows: []core.BoxShadow{ui.Shadow(0, 10, 26, 0, ui.Black(0.16))},
				PointerEvents: core.PointerEventsNone},
			StyleFunc: func() core.Style {
				st := core.Style{Opacity: core.Alpha(1)}
				if !a.reduceEffects.Get() && !ui.ReduceMotion(cx) {
					st.Transition = core.Transition{Duration: 120 * time.Millisecond, Easing: core.EaseOut,
						Properties: core.TransitionOpacity | core.TransitionTransform}
				}
				if !a.axisHintIn.Get() {
					st.Opacity = core.Alpha(0)
					st.Transform = core.Transform{TranslateY: 2}
				}
				return st
			},
			Children: []core.Node{core.Text{Content: tip, MaxLines: 3, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 11.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Text)}},
		}
	})
}

// jumpToTurn scrolls the transcript to a fraction of its scrollable length.
func (a *app) jumpToTurn(s *session, fraction float64) {
	a.scrollToOffset(s, float64(a.scrollRoom(s))*fraction)
}

// scrollRoom is how far the transcript can scroll, 0 when it fits.
func (a *app) scrollRoom(s *session) core.Points {
	frame, ok := s.conversation.Scroll().Frame()
	content, hasContent := s.conversation.Scroll().ContentBounds()
	if !ok || !hasContent {
		return 0
	}
	if maxY := content.Size.Height - frame.Size.Height; maxY > 0 {
		return maxY
	}
	return 0
}

// scrollToOffset puts the top of the transcript at a content offset.
func (a *app) scrollToOffset(s *session, y float64) {
	room := float64(a.scrollRoom(s))
	if room <= 0 {
		return
	}
	s.conversation.Scroll().ScrollTo(core.Point{Y: core.Points(math.Min(math.Max(0, y), room))}, true)
}

// axisTip is what the ruler says over a mark: the turn it stands for, and
// the start of its prompt.
func (a *app) axisTip(s *session, i int) string {
	turns := s.turns.GetUntracked()
	if i < 0 || i >= len(turns) {
		return ""
	}
	summary := viewkit.FirstLine(turns[i].Prompt, 60)
	if summary == "" {
		summary = viewkit.FirstLine(turns[i].Final, 60)
	}
	if summary == "" {
		return apptext.T("第 %d 轮", i+1)
	}
	return apptext.T("第 %d 轮 · %s", i+1, summary)
}
