package main

import (
	_ "embed"
	"fmt"
	"os"
	"runtime/debug"

	"github.com/nsgo-dev/nsgo"
	"github.com/nsgo-dev/nsgo/core"
)

// appVersion is the version the about page and diagnostics report.
const appVersion = "0.2.0"

// logoPNG is PiDeck's mark, drawn in the wordmark and the welcome screen.
//
//go:embed assets/logo.png
var logoPNG []byte

// Root builds the app once; signals drive everything after that. The
// phone build shows the remote client instead of the desktop workbench.
// The whole interface sits under an error boundary, so a panic in one
// screen becomes a crash screen and a crash log instead of a dead app.
func Root(cx *core.Scope) core.Node {
	if mobileMode() {
		m := newMobileApp(cx)
		return core.Catch{
			Try: func(*core.Scope) core.Node { return m.view() },
			Fallback: func(cx *core.Scope, err error, reset func()) core.Node {
				return crashScreenFor(cx, err, reset, "", nil, nil)
			},
		}
	}
	a := newApp(cx)
	return core.Catch{
		Try: func(*core.Scope) core.Node {
			return core.Dynamic(func(cx *core.Scope) core.Node {
				font := a.uiFont.Get()
				img := a.bgImage.Get()
				if img == "" {
					return core.View{Style: core.Style{Width: core.Pct(100), Height: core.Pct(100), FontFamily: font},
						Children: []core.Node{a.view()}}
				}
				mask := core.RGBA(0xffffff, float32(1-a.bgOpacity.Get()))
				if cx.Env().Dark() {
					mask = core.RGBA(0x000000, float32(1-a.bgOpacity.Get()))
				}
				fill := core.Style{Position: core.Absolute, Top: core.Pt(0), Left: core.Pt(0), Right: core.Pt(0), Bottom: core.Pt(0)}
				return core.View{Style: core.Style{Width: core.Pct(100), Height: core.Pct(100), FontFamily: font}, Children: []core.Node{
					core.Image{Source: core.ImageSource{URI: fileURL(img)}, ResizeMode: core.Cover,
						Style: fill.Merge(core.Style{PointerEvents: core.PointerEventsNone})},
					core.View{Style: fill.Merge(core.Style{Background: mask, PointerEvents: core.PointerEventsNone})},
					core.View{Style: core.Style{Width: core.Pct(100), Height: core.Pct(100)}, Children: []core.Node{a.view()}},
				}}
			})
		},
		Fallback: func(cx *core.Scope, err error, reset func()) core.Node {
			return a.crashScreen(cx, err, reset)
		},
	}
}

func main() {
	// A panic outside the interface still leaves a crash log behind.
	defer func() {
		if r := recover(); r != nil {
			if path, err := writeCrashReport(crashDataDirNow(), r, debug.Stack()); err == nil {
				fmt.Fprintln(os.Stderr, "PiDeck Lite: crash log written to", path)
			}
			panic(r)
		}
	}()
	var opts []nsgo.Option
	if !mobileMode() {
		opts = append(opts, nsgo.WindowSize(1320, 860),
			nsgo.WindowConstraints(core.WindowConstraints{MinWidth: 960, MinHeight: 640}))
	}
	nsgo.Run(Root, opts...)
	closeAllPi()
	closeAllACP()
	closeAllTerminals()
}
