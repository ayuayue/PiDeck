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
	if !clientMode() {
		opts = append(opts, nsgo.WindowSize(1320, 860),
			nsgo.WindowConstraints(core.WindowConstraints{MinWidth: 960, MinHeight: 640}))
	}
	nsgo.Run(Root, opts...)
	shutdownHosts()
}
