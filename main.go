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

// Root builds the app once; signals drive everything after that.
func Root(cx *core.Scope) core.Node {
	a := newApp(cx)
	return a.view()
}

func main() {
	nsgo.Run(Root,
		nsgo.WindowSize(1320, 860),
		nsgo.WindowConstraints(core.WindowConstraints{MinWidth: 960, MinHeight: 640}),
	)
	closeAllPi()
	closeAllTerminals()
}
