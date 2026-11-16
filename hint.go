//go:build !js && !android && !ios

package main

import (
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// hint shows a label while the pointer rests on a control. ui.Button and
// ui.IconButton take a Label for assistive technology only, so the app
// wraps what has no words of its own.
func hint(label string, n core.Node) core.Node {
	return hintOf(func() string { return label }, n)
}

// hintOf is hint for a label that can change, such as a translated one or
// one naming the session in front.
func hintOf(label func() string, n core.Node) core.Node {
	return ui.Tooltip{TextFunc: label, Trigger: n, Style: core.Style{FlexShrink: 0}}
}
