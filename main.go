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
	limitHeap()
	var opts []nsgo.Option
	if !client.Mode() {
		opts = append(opts, nsgo.WindowConstraints(core.WindowConstraints{MinWidth: 960, MinHeight: 640}))
		// A window that was resized or moved opens there, at that size.
		if frame, ok := initialWindowFrame(); ok {
			opts = append(opts, nsgo.WindowFrame(frame))
		} else {
			opts = append(opts, nsgo.WindowSize(1320, 860))
		}
		// One copy runs per app ID: a second launch hands itself to the first
		// and exits. A key of its own keeps a development run beside the
		// installed package, which otherwise swallows it and shows its own
		// older code.
		if key := os.Getenv("PIDECK_V2_INSTANCE"); key != "" {
			opts = append(opts, nsgo.InstanceKey(key))
		}
	}
	nsgo.Run(Root, opts...)
	shutdownHosts()
}

// desktopHeapLimit caps a long desktop session's heap. Go collects only after
// the heap doubles, so a transcript that once filled several gigabytes leaves
// that peak in Task Manager long after it is closed; a soft limit ties the peak
// to what is actually live. A GOMEMLIMIT the user set wins, and the mobile and
// web clients keep their own budget.
const desktopHeapLimit = 3 << 30

func limitHeap() {
	if client.Mode() || os.Getenv("GOMEMLIMIT") != "" {
		return
	}
	debug.SetMemoryLimit(desktopHeapLimit)
}
