//go:build !js && !android && !ios

package workbench

// The desktop and phone builds' entry: the workbench, or the remote client
// when the target is iOS, Android or a preview (PIDECK_LITE_MOBILE=1).

import (
	"github.com/nsgo-dev/nsgo/core"
)

// Root builds the app once; signals drive everything after that. The
// phone build shows the remote client instead of the desktop workbench.
// The whole interface sits under an error boundary, so a panic in one
// screen becomes a crash screen and a crash log instead of a dead app.
func Root(cx *core.Scope) core.Node {
	a := newApp(cx)
	return core.Catch{
		Try: func(*core.Scope) core.Node {
			return core.Dynamic(func(cx *core.Scope) core.Node {
				// Rebuild dialogs as well as the shell when the language changes.
				a.langRev.Get()
				font := a.uiFont.Get()
				// The reading sizes are built into the views below, so a
				// changed size rebuilds the window.
				a.chatFont.Get()
				a.chatLine.Get()
				a.inputFont.Get()
				img := a.bgImage.Get()
				if img == "" {
					return core.View{Style: core.Style{Width: core.Pct(100), Height: core.Pct(100), FontFamily: font},
						Children: []core.Node{a.view()}}
				}
				fill := core.Style{Position: core.Absolute, Top: core.Pt(0), Left: core.Pt(0), Right: core.Pt(0), Bottom: core.Pt(0)}
				mask := core.Dynamic(func(cx *core.Scope) core.Node {
					// The veil keeps the picture quiet enough for the panels to
					// read over it. A dark room needs more of it: a light picture
					// under translucent dark panels would come out grey.
					base, veil := uint32(0xffffff), float32(1-a.bgOpacity.Get())
					if cx.Env().Dark() {
						base, veil = 0x000000, min(1, veil+0.3)
					}
					return core.View{Style: fill.Merge(core.Style{Background: core.RGBA(base, veil),
						PointerEvents: core.PointerEventsNone})}
				})
				return core.View{Style: core.Style{Width: core.Pct(100), Height: core.Pct(100), FontFamily: font}, Children: []core.Node{
					core.Image{Source: core.ImageSource{URI: img}, ResizeMode: core.Cover,
						Style: fill.Merge(core.Style{PointerEvents: core.PointerEventsNone})},
					mask,
					core.View{Style: core.Style{Width: core.Pct(100), Height: core.Pct(100)}, Children: []core.Node{a.view()}},
				}}
			})
		},
		Fallback: func(cx *core.Scope, err error, reset func()) core.Node {
			return a.crashScreen(cx, err, reset)
		},
	}
}
