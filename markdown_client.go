//go:build js

package main

// A page renders formulas and code colour as the workbench does, but not
// diagrams: limu is the largest of the three dependencies, and a browser
// downloads the whole page before it draws. A diagram shows as its source.

import (
	"github.com/nsgo-dev/nsgo/base/formula"
	"github.com/nsgo-dev/nsgo/base/textview"
	"github.com/nsgo-dev/nsgo/base/textview/highlight"
	"github.com/nsgo-dev/nsgo/core"
)

var renderMath = formula.RenderMath

var renderDiagram func(cx *core.Scope, code textview.CodeBlock) core.Node

func newHighlighter(cx *core.Scope) textview.Highlighter { return highlight.New(cx) }
