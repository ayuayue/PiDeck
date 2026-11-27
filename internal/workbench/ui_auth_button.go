//go:build !js && !android && !ios

package workbench

import (
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// Select closes on mouse-down, while Windows hit-tests again on release.
// Require the action's own press-down so choosing a provider cannot click
// through its popup. Keyboard and accessibility activation remain available.
func authActionButton(button ui.Button) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		view := button.Render(cx).(base.Button)
		pressed := false
		cx.Effect(func() {
			if core.MouseButtonHeld(cx, core.MouseButtonLeft) {
				pressed = false
			}
		})
		action := view.OnPress
		view.OnPressDown = func(core.PressEvent) { pressed = true }
		view.OnPress = func(event core.PressEvent) {
			started := pressed
			pressed = false
			if action != nil && (started || event.Keyboard || event.Position == (core.Point{})) {
				action(event)
			}
		}
		return view
	})
}
