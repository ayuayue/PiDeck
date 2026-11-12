package main

import (
	_ "embed"

	"github.com/oneo-me/nsgo"
	"github.com/oneo-me/nsgo/core"
)

// logoPNG is PiDeck's mark, drawn in the wordmark and the welcome screen.
//
//go:embed assets/logo.png
var logoPNG []byte

// Root builds the app once; signals drive everything after that. The
// phone build shows the remote client instead of the desktop workbench.
func Root(cx *core.Scope) core.Node {
	if mobileMode() {
		return newMobileApp(cx).view()
	}
	a := newApp(cx)
	return a.view()
}

func main() {
	var opts []nsgo.Option
	if !mobileMode() {
		opts = append(opts, nsgo.WindowSize(1320, 860),
			nsgo.WindowConstraints(core.WindowConstraints{MinWidth: 960, MinHeight: 640}))
	}
	nsgo.Run(Root, opts...)
	closeAllPi()
	closeAllTerminals()
}
