package main

import (
	"fmt"
	"os"
	"runtime/debug"

	"example.com/pideck-v2/internal/client"
	"example.com/pideck-v2/internal/crashlog"
	_ "example.com/pideck-v2/locales"
	"github.com/nsgo-dev/nsgo"
	"github.com/nsgo-dev/nsgo/core"
)

func main() {
	// A panic outside the interface still leaves a crash log behind.
	defer func() {
		if r := recover(); r != nil {
			if path, err := crashlog.WriteReport(crashlog.DataDir(), r, debug.Stack()); err == nil {
				fmt.Fprintln(os.Stderr, "PiDeck V2: crash log written to", path)
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
