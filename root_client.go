//go:build js || android || ios

package main

import (
	"example.com/pideck-v2/internal/client"
	"github.com/nsgo-dev/nsgo/core"
)

func Root(cx *core.Scope) core.Node                { return client.Root(cx) }
func initialWindowFrame() (core.WindowFrame, bool) { return core.WindowFrame{}, false }
func shutdownHosts()                               {}
