//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"fmt"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// noteBlock is a system note, such as a compaction summary.
func (a *app) noteBlock(title, body string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		children := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
				ui.Icon(lucide.Minimize2, 13, colors.Faint),
				core.Text{Content: title, Style: core.Style{FontSize: a.readingRowFont(), FontWeight: ui.Medium},
					StyleFunc: ui.Colored(colors.Muted)},
			}},
		}
		if body != "" {
			children = append(children, viewkit.MarkdownSized(body, func() bool { return false }, false, a.readingRowFont(), a.readingRowLine(), core.Style{Color: colors.Muted()}))
		}
		return core.View{StyleFunc: func() core.Style {
			return core.Style{Gap: 8, Padding: core.Symmetric(8, 12), CornerRadius: ui.RadiusControl,
				BorderWidth: 1, BorderColor: colors.Border(), Background: colors.Inset()}
		}, Children: children}
	})
}

// toolRow is one tool call: its verb and target, a live line while it
// runs, and its output or diff once the user opens it. While a call runs
// its row opens by itself, so output arrives in place; the user's own
// choice then wins. The state lives on the session, keyed by the call, so
// rebuilding the turn never closes a row the user opened.
func (a *app) toolRow(s *session, run toolRun) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		s.uiSeq.Get() // redraw when a row opens or closes
		key := s.ID + "/" + run.CallID
		running := run.Status == chat.Running
		open := s.toolOpen(key, running)
		body := toolBodyText(run)
		rowSize, detailSize := a.readingRowFont(), a.readingDetailFont()
		header := []core.Node{
			ui.IconOf(func() *core.SVG { return toolIcon(run) }, 14, func() core.Color {
				switch {
				case run.IsError:
					return colors.Danger()
				case running:
					return colors.Info()
				}
				return colors.Muted()
			}),
			core.Text{Content: run.Action, MaxLines: 1,
				Style:     core.Style{FontSize: rowSize, FontWeight: ui.Medium, FlexShrink: 0},
				StyleFunc: ui.Colored(colors.Muted)},
			core.Text{Content: shorten(run.Detail, 140), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: detailSize},
				StyleFunc: ui.Colored(colors.Faint)},
		}
		if run.Added > 0 || run.Removed > 0 {
			header = append(header, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, FlexShrink: 0},
				Children: []core.Node{
					ui.Tabular(core.Text{Content: fmt.Sprintf("+%d", run.Added), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: detailSize},
						StyleFunc: ui.Colored(colors.Up)}),
					ui.Tabular(core.Text{Content: fmt.Sprintf("−%d", run.Removed), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: detailSize},
						StyleFunc: ui.Colored(colors.Danger)}),
				}})
		}
		if len(run.Nested) > 0 {
			header = append(header, core.Text{Content: fmt.Sprintf("内含 %d 次调用", len(run.Nested)), MaxLines: 1,
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: detailSize, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)})
		}
		switch {
		case running:
			header = append(header, ui.Spinner{Size: 10})
		case run.DurationMs > 0:
			header = append(header, ui.Tabular(core.Text{Content: fmt.Sprintf("%d ms", run.DurationMs),
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: detailSize, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)}))
		}
		if run.IsError {
			header = append(header, core.Text{Content: apptext.T("失败"), Style: core.Style{FontSize: detailSize, FontWeight: ui.Medium, FlexShrink: 0},
				StyleFunc: ui.Colored(colors.Danger)})
		}
		if body != "" {
			header = append(header, ui.IconOf(func() *core.SVG {
				if open {
					return lucide.ChevronDown()
				}
				return lucide.ChevronRight()
			}, 12, colors.Faint))
		}
		rows := []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(28),
			Padding: core.Symmetric(2, 6), MinWidth: core.Pt(0)}, Children: header}}
		if open && body != "" {
			rows = append(rows, core.View{Style: core.Style{MinWidth: core.Pt(0), MaxHeight: core.Pt(320), Borders: core.Edges{Top: 1},
				BorderColors: core.EdgeColors{Top: colors.Now().Line}}, Children: []core.Node{
				core.Scroll{Style: core.Style{MinWidth: core.Pt(0)}, Children: []core.Node{
					core.View{Style: core.Style{Padding: core.Symmetric(8, 10), Gap: 4}, Children: a.toolBodyNodes(cx, run)},
				}},
			}})
		}
		return core.View{
			OnPress: func(core.PressEvent) {
				if body == "" {
					return
				}
				s.toggleOpen(key)
			},
			Role: core.RoleButton, Label: strings.TrimSpace(run.Action + " " + run.Detail),
			StyleFunc: func() core.Style {
				st := core.Style{MinWidth: core.Pt(0), CornerRadius: 8, Background: core.Transparent, Overflow: core.Hidden}
				if body != "" {
					st.Hover = &core.Style{Background: ui.Mix(colors.Background(), colors.Text(), 0.04)}
				}
				if open {
					st.Background = ui.Mix(colors.Background(), colors.Text(), 0.03)
				}
				return st
			},
			Children: rows,
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
	case "task", "agent":
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
