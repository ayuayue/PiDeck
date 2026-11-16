package main

// Prose in the transcript: the workbench and the phone or browser client
// render it the same way, so this lives apart from the chat, which only the
// workbench has. The renderers it uses are chosen per build, in
// markdown_desktop.go and markdown_client.go.

import (
	"github.com/nsgo-dev/nsgo/base/textview"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// markdownView renders prose. A streaming one repairs what the text leaves
// open and ends with a pulsing caret.
func markdownView(text string, streaming func() bool, caret bool) core.Node {
	return markdownSearchView(nil, text, streaming, caret)
}

// markdownSearchView is markdownView joined to a transcript search, which
// highlights its matches.
func markdownSearchView(search *textview.Search, text string, streaming func() bool, caret bool) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		styles := ui.TextViewStyles(cx)
		styles[textview.PartRoot] = styles[textview.PartRoot].Merge(core.Style{Gap: 10, FontSize: 13.5, LineHeight: 22})
		colors := ui.ColorsOf(cx)
		styles[textview.PartSearch] = core.Style{Background: ui.Alpha(colors.Accent(), 0.18)}
		styles[textview.PartSearchSelected] = core.Style{Background: ui.Alpha(colors.Accent(), 0.45)}
		hl := newHighlighter(cx)
		on := streaming()
		return ui.TextView{
			MarkdownFunc:         func() string { return text },
			Options:              textview.Options{Streaming: on},
			Styles:               styles,
			Search:               search,
			Selectable:           true,
			Highlighter:          hl,
			OpenLinks:            true,
			RenderMath:           renderMath,
			RenderDiagram:        renderDiagram,
			NoCodeBlockScrollbar: true,
			CodeBlockActions:     []textview.CodeAction{{ID: textview.CopyAction, Label: T("复制")}},
		}
	})
}
