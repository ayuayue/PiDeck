//go:build !js

package main

// The workbench's prose gets the works: typeset formulas, drawn diagrams
// and syntax colour. The browser client leaves the diagram engine out.

import (
	"github.com/nsgo-dev/nsgo/base/diagram"
	"github.com/nsgo-dev/nsgo/base/formula"
	"github.com/nsgo-dev/nsgo/base/textview"
	"github.com/nsgo-dev/nsgo/base/textview/highlight"
	"github.com/nsgo-dev/nsgo/core"
)

var renderMath = formula.RenderMath

var renderDiagram = diagram.RenderDiagram

func newHighlighter(cx *core.Scope) textview.Highlighter { return highlight.New(cx) }
