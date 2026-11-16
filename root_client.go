//go:build js || android || ios

package main

// A browser has no processes and no disk, so the page is a client of a
// desktop's server: the phone's screens, under the same error boundary.
// Nothing of the workbench is reachable from here, which is what keeps it
// out of app.wasm.

import (
	"github.com/nsgo-dev/nsgo/core"
)

// Root builds the client once; signals drive everything after that.
func Root(cx *core.Scope) core.Node {
	m := newMobileApp(cx)
	return core.Catch{
		Try: func(*core.Scope) core.Node { return m.view() },
		Fallback: func(cx *core.Scope, err error, reset func()) core.Node {
			return crashScreenFor(cx, err, reset, "", nil, nil)
		},
	}
}
