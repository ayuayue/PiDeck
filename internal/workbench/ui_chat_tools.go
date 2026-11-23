//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// toolRow is one tool call: its verb and target, a live line while it
// runs, and its output or diff once the user opens it. While a call runs
// its row opens by itself, so output arrives in place; the user's own
// choice then wins. The state lives on the session, keyed by the call, so
// toolRow is one tool call inside a process group: its verb and target, a
// live line while it runs, and its output or diff once the user opens it.
// While a call runs its row opens by itself, so output arrives in place;
// the user's own choice then wins. The state lives on the session, keyed by
// the call, so a rebuild never closes a row the user opened.
func (a *app) toolRow(s *session, run func() toolRun) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		key := s.ID + "/tool/" + run().CallID
		running := func() bool { return run().Status == chat.Running }
		open := func() bool {
			s.uiSeq.Get() // redraw when a row opens or closes
			return s.toolOpen(key, running())
		}
		hasBody := func() bool {
			r := run()
			return toolBodyText(r) != "" || len(r.Images) > 0
		}
		rowSize, detailSize := a.readingRowFont(), a.readingDetailFont()
		header := viewkit.ToolRow(cx, viewkit.ToolLine{
			Glyph:      func() *core.SVG { return toolIcon(run()) },
			Verb:       apptext.T(run().Action),
			Detail:     shorten(run().Detail, 140),
			Added:      run().Added,
			Removed:    run().Removed,
			Nested:     len(run().Nested),
			DurationMs: run().DurationMs,
			Running:    running(),
			Failed:     run().IsError,
			Open:       open(),
			HasBody:    hasBody(),
		}, viewkit.ToolSizes{Verb: rowSize, Detail: detailSize, Glyph: 14, Gap: 8, MinHeight: 28, PadV: 2, PadH: 6})
		body := core.Show{When: func() bool { return open() && hasBody() }, Then: func(cx *core.Scope) core.Node {
			children := []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
				return core.Group(a.toolBodyNodes(cx, run()))
			})}
			return core.View{Style: core.Style{MinWidth: core.Pt(0), MaxHeight: core.Pt(320), Borders: core.Edges{Top: 1},
				BorderColors: core.EdgeColors{Top: colors.Now().Line}}, Children: []core.Node{
				core.Scroll{Style: core.Style{MinWidth: core.Pt(0)}, Children: []core.Node{
					core.View{Style: core.Style{Padding: core.Symmetric(8, 10), Gap: 4}, Children: append(children,
						core.Show{When: func() bool { return len(run().Images) > 0 }, Then: func(cx *core.Scope) core.Node {
							images := run().Images
							tiles := make([]core.Node, 0, len(images))
							for _, img := range images {
								tiles = append(tiles, a.transcriptImageTile(img))
							}
							return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: tiles}
						}})},
				}},
			}}
		}}
		return core.View{
			OnPress: func(core.PressEvent) {
				if !hasBody() {
					return
				}
				s.toggleOpen(key)
			},
			Role: core.RoleButton, LabelFunc: func() string {
				r := run()
				return strings.TrimSpace(r.Action + " " + r.Detail)
			},
			StyleFunc: func() core.Style {
				st := core.Style{MinWidth: core.Pt(0), CornerRadius: 8, Background: core.Transparent, Overflow: core.Hidden}
				if hasBody() {
					st.Hover = &core.Style{Background: ui.Mix(colors.Background(), colors.Text(), 0.04)}
				}
				if open() {
					st.Background = ui.Mix(colors.Background(), colors.Text(), 0.03)
				}
				return st
			},
			Children: []core.Node{
				header,
				body,
			},
		}
	})
}

// toolIcon is the glyph of what a tool does.
func toolIcon(run toolRun) *core.SVG {
	switch {
	case run.Status == chat.Running:
		return lucide.Loader()
	case run.IsError:
		return lucide.CircleAlert()
	}
	switch run.Name {
	case "bash":
		return lucide.Terminal()
	case "read":
		return lucide.FileText()
	case "write":
		return lucide.FilePlus()
	case "edit":
		return lucide.Pencil()
	case "grep", "find":
		return lucide.Search()
	case "ls":
		return lucide.Folder()
	case "web_search", "websearch":
		return lucide.Globe()
	case "fetch_content", "webfetch", "web_fetch":
		return lucide.Link()
	case "todo", "todowrite":
		return lucide.ListChecks()
	case "task", "agent", "Agent", "delegate", "acp_delegate", "subagent":
		return lucide.Bot()
	case "codemode":
		return lucide.Code()
	}
	return lucide.Wrench()
}

// toolBodyText is what a row can show at all: output, a diff, or nested
// calls.
func toolBodyText(run toolRun) string {
	if run.Diff != "" {
		return run.Diff
	}
	if run.Output != "" {
		return run.Output
	}
	if len(run.Nested) > 0 {
		return strings.Join(run.Nested, "\n")
	}
	return ""
}

// toolBodyNodes is an open row's body: a diff colored by its signs, or the
// output as it came.
func (a *app) toolBodyNodes(cx *core.Scope, run toolRun) []core.Node {
	colors := ui.ColorsOf(cx)
	size, rowLine := a.readingDetailFont(), a.readingDetailLine()
	if run.Diff != "" {
		var lines []core.Node
		for _, line := range strings.Split(run.Diff, "\n") {
			c := colors.Code()
			bg := core.Transparent
			switch {
			case strings.HasPrefix(line, "+"):
				c, bg = colors.Up(), ui.Alpha(colors.Up(), 0.08)
			case strings.HasPrefix(line, "-"):
				c, bg = colors.Danger(), ui.Alpha(colors.Danger(), 0.07)
			case strings.HasPrefix(line, "@"):
				c = colors.Faint()
			}
			ink := c
			lines = append(lines, core.Text{Content: line, Selectable: core.SelectableOn,
				Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: size, LineHeight: rowLine, Background: bg, Width: core.Pct(100)},
				StyleFunc: ui.Colored(func() core.Color { return ink })})
		}
		return lines
	}
	var nodes []core.Node
	for _, line := range run.Nested {
		nodes = append(nodes, core.Text{Content: "· " + line, Selectable: core.SelectableOn,
			Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: size, LineHeight: rowLine}, StyleFunc: ui.Colored(colors.Faint)})
	}
	out := run.Output
	if out == "" {
		out = "（没有输出）"
	}
	nodes = append(nodes, core.Text{Content: out, Selectable: core.SelectableOn,
		Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: size, LineHeight: rowLine}, StyleFunc: ui.Colored(colors.Code)})
	return nodes
}

// errorRow is a failure and how to try again.
func (a *app) errorRow(retry func(), text string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, Padding: core.Symmetric(10, 12),
				CornerRadius: ui.RadiusControl, Background: ui.Alpha(colors.Danger(), 0.07),
				BorderWidth: 1, BorderColor: ui.Alpha(colors.Danger(), 0.28)}
		}, Children: []core.Node{
			ui.Icon(lucide.CircleAlert, 16, colors.Danger),
			core.Text{Content: text, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, LineHeight: 19},
				StyleFunc: ui.Colored(colors.Text)},
			ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: retry},
		}}
	})
}
