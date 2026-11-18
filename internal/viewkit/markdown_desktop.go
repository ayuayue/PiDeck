//go:build !js && !android && !ios

package viewkit

// The workbench's prose gets the works: typeset formulas, drawn diagrams
// and syntax colour.

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
