package viewkit

// Prose in the transcript: the workbench and the phone or browser client
// render it the same way, so this lives apart from the chat, which only the
// workbench has. The renderers it uses are chosen per build, in
// markdown_desktop.go and markdown_client.go.

import (
	"unicode/utf8"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base/textview"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// markdownView renders prose. A streaming one repairs what the text leaves
// open and ends with a pulsing caret. It takes the kit's sizes.
func Markdown(text string, streaming func() bool, caret bool) core.Node {
	return MarkdownSearch(nil, text, streaming, caret, 0, 0, core.Style{})
}

// markdownSized is markdownView at the transcript's reading size; a size of
// 0 keeps the kit's.
func MarkdownSized(text string, streaming func() bool, caret bool, size, line core.Points, tone core.Style) core.Node {
	return MarkdownSearch(nil, text, streaming, caret, size, line, tone)
}

// markdownSearchView is markdownView joined to a transcript search, which
// highlights its matches. size and line scale every part, so headings and
// code follow the prose; 0 keeps the kit's sizes.
func MarkdownSearch(search *textview.Search, text string, streaming func() bool, caret bool, size, line core.Points, tone core.Style) core.Node {
	return MarkdownWithCodeWrap(search, text, streaming, caret, size, line, tone, nil)
}

// MarkdownWithCodeWrap lets a host choose the wrapping code renderer.
func MarkdownWithCodeWrap(search *textview.Search, text string, streaming func() bool, caret bool, size, line core.Points, tone core.Style, wrapCode func() bool) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		styles := ui.TextViewStyles(cx)
		if size > 0 {
			// Every part the kit sizes is scaled by the same ratio, so a
			// heading keeps its place above the prose.
			ratio := float64(size) / ChatFontDefault
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
			st.FontFamily = MonoFont()
			styles[part] = st
		}
		rootLine := core.Points(22)
		rootSize := core.Points(ChatFontDefault)
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
		view := ui.TextView{
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
			CodeBlockActions:     []textview.CodeAction{{ID: textview.CopyAction, Label: apptext.T("复制")}},
		}
		if wrapCode != nil && wrapCode() {
			view.RenderCodeBlock = func(cx *core.Scope, code textview.CodeBlock) core.Node {
				return wrappedCode(cx, code, hl, styles[textview.PartCodeBlock], styles[textview.PartCodeBlockCode])
			}
		}
		return view
	})
}

func wrappedCode(cx *core.Scope, code textview.CodeBlock, highlight textview.Highlighter, surface, text core.Style) core.Node {
	return core.View{Style: surface.Merge(core.Style{Padding: core.Symmetric(8, 12), Gap: 4, MinWidth: core.Pt(0)}), Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifyEnd}, Children: []core.Node{
			ui.Button{Text: apptext.T("复制"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { cx.SetClipboard(code.Code) }},
		}},
		core.Text{SpansFunc: func() []core.Span {
			var spans []core.Span
			last := 0
			for _, h := range highlight(code) {
				if h.Start < last || h.End <= h.Start || h.End > len(code.Code) ||
					!utf8.RuneStart(code.Code[h.Start]) || (h.End < len(code.Code) && !utf8.RuneStart(code.Code[h.End])) {
					continue
				}
				if h.Start > last {
					spans = append(spans, core.Span{Content: code.Code[last:h.Start]})
				}
				spans = append(spans, core.Span{Content: code.Code[h.Start:h.End], Class: h.Class, Style: h.Style})
				last = h.End
			}
			if last < len(code.Code) {
				spans = append(spans, core.Span{Content: code.Code[last:]})
			}
			return spans
		}, Selectable: core.SelectableOn, Style: text.Merge(core.Style{WhiteSpace: core.WhiteSpaceNormal, MinWidth: core.Pt(0)})},
	}}
}
