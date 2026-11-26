//go:build !js && !android && !ios

package workbench

import (
	"time"

	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// navigationSelection keeps one highlight alive while keyed tabs retain their
// focus and content. Native layout transitions can retarget an unfinished move.
// Resizing and the first measurement place the highlight without an entrance.
type navigationSelection struct {
	a        *app
	cx       *core.Scope
	selected func() string
	frames   map[string]*core.Signal[core.Bounds]
	width    *core.Signal[core.Points]
	moving   *core.Signal[bool]
}

func (a *app) navigationSelection(cx *core.Scope, selected func() string) *navigationSelection {
	n := &navigationSelection{a: a, cx: cx, selected: selected,
		frames: map[string]*core.Signal[core.Bounds]{}, width: core.NewSignal(cx, core.Points(0)), moving: core.NewSignal(cx, false)}
	last := core.Untracked(cx, selected)
	cx.Effect(func() {
		reduced := a.navigationReduced(cx)
		id := selected()
		if reduced {
			n.moving.Set(false)
		}
		if id != last {
			from := n.frame(last).GetUntracked()
			to := n.frame(id).GetUntracked()
			n.moving.Set(!reduced && from.Size.Width > 0 && to.Size.Width > 0)
			last = id
		}
	})
	return n
}

func (n *navigationSelection) frame(id string) *core.Signal[core.Bounds] {
	if f := n.frames[id]; f != nil {
		return f
	}
	f := core.NewSignal(n.cx, core.Bounds{})
	n.frames[id] = f
	return f
}

func (n *navigationSelection) measure(id string) func(core.Bounds) { return n.frame(id).Set }
func (n *navigationSelection) measureList(b core.Bounds)           { n.width.Set(b.Size.Width) }

func (n *navigationSelection) indicator(testID string, look func() core.Style) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Remount only the decoration when the preference changes: removing a
		// transition alone does not stop the platform's already-running move.
		reduced := n.a.navigationReduced(cx)
		return core.View{TestID: testID, PointerEvents: core.PointerEventsNone,
			OnTransitionEnd: func() { n.moving.Set(false) }, StyleFunc: func() core.Style {
				f := n.frame(n.selected()).Get()
				left := f.Origin.X
				if n.cx.Env().RTL() {
					left = n.width.Get() - left - f.Size.Width
				}
				st := look().Merge(core.Style{Position: core.Absolute, Left: core.Pt(left), Top: core.Pt(f.Origin.Y),
					Width: core.Pt(f.Size.Width), Height: core.Pt(f.Size.Height)})
				if n.moving.Get() && !reduced {
					st.Transition = core.Transition{Duration: 180 * time.Millisecond, Easing: core.EaseOut, Properties: core.TransitionLayout}
				}
				return st
			}}
	})
}

func (a *app) navigationReduced(cx *core.Scope) bool {
	return a.reduceEffects.Get() || ui.ReduceMotion(cx)
}

func (a *app) navigationPressMotion(cx *core.Scope) core.Transition {
	if a.navigationReduced(cx) {
		return core.Transition{}
	}
	return viewkit.PressMotion
}
