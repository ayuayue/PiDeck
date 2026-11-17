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
// open and ends with a pulsing caret. It takes the kit's sizes.
func markdownView(text string, streaming func() bool, caret bool) core.Node {
	return markdownSearchView(nil, text, streaming, caret, 0, 0, core.Style{})
}

// markdownSized is markdownView at the transcript's reading size; a size of
// 0 keeps the kit's.
func markdownSized(text string, streaming func() bool, caret bool, size, line core.Points, tone core.Style) core.Node {
	return markdownSearchView(nil, text, streaming, caret, size, line, tone)
}

// markdownSearchView is markdownView joined to a transcript search, which
// highlights its matches. size and line scale every part, so headings and
// code follow the prose; 0 keeps the kit's sizes.
func markdownSearchView(search *textview.Search, text string, streaming func() bool, caret bool, size, line core.Points, tone core.Style) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		styles := ui.TextViewStyles(cx)
		if size > 0 {
			// Every part the kit sizes is scaled by the same ratio, so a
			// heading keeps its place above the prose.
			ratio := float64(size) / chatFontDefault
			for part, st := range styles {
				if st.FontSize > 0 {
					st.FontSize = core.Points(float64(st.FontSize) * ratio)
				}
				if st.LineHeight > 0 {
					st.LineHeight = core.Points(float64(st.LineHeight) * ratio)
				}
				styles[part] = st
			}
		}
		for _, part := range []textview.Part{textview.PartCode, textview.PartCodeBlockCode} {
			st := styles[part]
			st.FontFamily = monoFont()
			styles[part] = st
		}
		rootLine := core.Points(22)
		rootSize := core.Points(chatFontDefault)
		if size > 0 {
			rootSize = size
		}
		if line > 0 {
			rootLine = line
		}
		// tone colors and weighs the prose (the process layer's muted
		// thinking body); headings, code and links keep their own colors.
		styles[textview.PartRoot] = styles[textview.PartRoot].Merge(core.Style{Gap: 10, FontSize: rootSize, LineHeight: rootLine}).Merge(tone)
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
