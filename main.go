package main

import (
	"fmt"
	"os"
	"runtime/debug"

	"example.com/pideck-lite/internal/client"
	"example.com/pideck-lite/internal/crashlog"
	_ "example.com/pideck-lite/locales"
	"github.com/nsgo-dev/nsgo"
	"github.com/nsgo-dev/nsgo/core"
)

func main() {
	// A panic outside the interface still leaves a crash log behind.
	defer func() {
		if r := recover(); r != nil {
			if path, err := crashlog.WriteReport(crashlog.DataDir(), r, debug.Stack()); err == nil {
				fmt.Fprintln(os.Stderr, "PiDeck Lite: crash log written to", path)
			}
			panic(r)
		}
	}()
	var opts []nsgo.Option
	if !client.Mode() {
		opts = append(opts, nsgo.WindowConstraints(core.WindowConstraints{MinWidth: 960, MinHeight: 640}))
		// A window that was resized or moved opens there, at that size.
		if frame, ok := initialWindowFrame(); ok {
			opts = append(opts, nsgo.WindowFrame(frame))
		} else {
			opts = append(opts, nsgo.WindowSize(1320, 860))
		}
	}
	nsgo.Run(Root, opts...)
	shutdownHosts()
}
