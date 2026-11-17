//go:build js || android || ios

package main

import "github.com/nsgo-dev/nsgo/core"

// Remote clients use the platform's window size and never restore a
// desktop frame from disk.
func initialWindowFrame() (core.WindowFrame, bool) {
	return core.WindowFrame{}, false
}
