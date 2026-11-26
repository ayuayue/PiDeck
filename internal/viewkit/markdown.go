package viewkit

// Prose in the transcript: the workbench and the phone or browser client
// render it the same way, so this lives apart from the chat, which only the
// workbench has. The renderers it uses are chosen per build, in
// markdown_desktop.go and markdown_client.go.

import (
	"unicode/utf8"

	"example.com/pideck-v2/internal/apptext"
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
	return MarkdownLive(search, func() string { return text }, streaming, size, line, tone, wrapCode)
}

// MarkdownBehavior lets a host decorate document references and handle their clicks.
type MarkdownBehavior struct {
	Document func(string) textview.Document
	Span     func(textview.Custom) core.Span
}

// MarkdownLive reparses changing text without remounting the surrounding view.
func MarkdownLive(search *textview.Search, text func() string, streaming func() bool, size, line core.Points, tone core.Style, wrapCode func() bool, behavior ...MarkdownBehavior) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		styles := ui.TextViewStyles(cx)
		font := size
		if font <= 0 {
			font = ChatFontDefault
		}
		// Scale from the kit's actual body size, not our reading default:
		// changing the default must not shrink inline code or headings.
		ratio := float64(font / ui.TypeBody.FontSize)
		for part, st := range styles {
			if st.FontSize > 0 {
				st.FontSize = core.Points(float64(st.FontSize) * ratio)
			}
			if st.LineHeight > 0 {
				st.LineHeight = core.Points(float64(st.LineHeight) * ratio)
			}
			styles[part] = st
		}
		for _, part := range []textview.Part{textview.PartCode, textview.PartCodeBlockCode} {
			st := styles[part]
			st.FontFamily = MonoFont()
			st.FontSize = font * 0.92
			st.LineHeight = st.FontSize * ChatLineDefault
			if part == textview.PartCode {
				st.FontSize = font * 0.875
			}
			styles[part] = st
		}
		// Electron's transcript headings are deliberately quiet: the
		// generic document scale overwhelms a conversational answer.
		for i, part := range []textview.Part{textview.PartHeading1, textview.PartHeading2, textview.PartHeading3,
			textview.PartHeading4, textview.PartHeading5, textview.PartHeading6} {
			st := styles[part]
			st.FontSize = font * []core.Points{1.3, 1.15, 1.06, 1.03, 1, 0.95}[i]
			st.LineHeight = st.FontSize * 1.3
			styles[part] = st
		}
		rootLine := core.Points(float64(font) * ChatLineDefault)
		if line > 0 {
			rootLine = line
		}
		// tone colors and weighs the prose (the process layer's muted
		// thinking body); headings, code and links keep their own colors.
		styles[textview.PartRoot] = styles[textview.PartRoot].Merge(core.Style{Gap: font * 0.7, FontSize: font, LineHeight: rootLine}).Merge(tone)
		colors := ui.ColorsOf(cx)
		card := styles[textview.PartCodeBlock]
		card.Background = colors.Surface()
		styles[textview.PartCodeBlock] = card
		styles[textview.PartSearch] = core.Style{Background: ui.Alpha(colors.Accent(), 0.18)}
		styles[textview.PartSearchSelected] = core.Style{Background: ui.Alpha(colors.Accent(), 0.45)}
		hl := newHighlighter(cx)
		// The repair belongs to the text, not to the view: a document still
		// arriving closes its open syntax, and the finished one parses as it
		// was written. Reading the stream here would rebuild the whole view
		// when the answer ends instead of parsing it once more in place.
		markdown := func() string {
			s := text()
			if streaming != nil && streaming() {
				return textview.RepairStreaming(s)
			}
			return s
		}
		view := ui.TextView{
			MarkdownFunc:         markdown,
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
		if len(behavior) > 0 && behavior[0].Document != nil {
			view.MarkdownFunc = nil
			view.DocumentFunc = func() textview.Document { return behavior[0].Document(markdown()) }
			view.CustomSpan = behavior[0].Span
			view.OpenLinks = false
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
