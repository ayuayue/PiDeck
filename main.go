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
				return core.View{Style: core.Style{Width: core.Pct(100), Height: core.Pct(100), FontFamily: a.uiFont.Get()},
					Children: []core.Node{a.view()}}
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
