//go:build !js && !android && !ios

package main

import (
	"example.com/pideck-lite/internal/client"
	"example.com/pideck-lite/internal/workbench"
	"github.com/nsgo-dev/nsgo/core"
)

// Root selects the local workbench or a remote-client preview.
func Root(cx *core.Scope) core.Node {
	if client.Mode() {
		return client.Root(cx)
	}
	return workbench.Root(cx)
}

func initialWindowFrame() (core.WindowFrame, bool) { return workbench.InitialWindowFrame() }
func shutdownHosts()                               { workbench.Shutdown() }
