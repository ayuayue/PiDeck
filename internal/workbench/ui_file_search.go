//go:build !js && !android && !ios

package workbench

// The find-in-files dialog: a query, the matches under their files, and a
// press to open one at its line.

import (
	"fmt"
	"path/filepath"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// fileSearchDialog searches the workspace's text files for a query.
func (a *app) fileSearchDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.fileSearchRev.Get()
		_ = a.fileSearchBusy.Get()
		_ = a.langRev.Get()
		root := a.quickOpenRoot()
		hits := a.fileSearchResults()
		query := a.fileSearchQuery.Get()
		busy := a.fileSearchBusy.Get()

		counts := map[string]int{}
		for _, hit := range hits {
			counts[hit.File]++
		}
		var rows []core.Node
		last := ""
		for _, hit := range hits {
			hit := hit
			if hit.File != last {
				last = hit.File
				rows = append(rows, core.View{TestID: "file-search-file",
					Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(4, 6),
						Margin: core.Edges{Top: 4}},
					Children: []core.Node{
						ui.Icon(lucide.FileText, 12, colors.Muted),
						core.Text{Content: hit.File, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 11},
							StyleFunc: ui.Colored(colors.Muted)},
						core.Text{Content: fmt.Sprintf("%d", counts[hit.File]), Style: core.Style{FontSize: 9.5},
							StyleFunc: ui.Colored(colors.Faint)},
					}})
			}
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) {
					if root == "" || root != a.quickOpenRoot() {
						return
					}
					a.fileSearchOpen.Set(false)
					a.openFileAt(root, filepath.Join(root, filepath.FromSlash(hit.File)), hit.Line)
				},
				Role: core.RoleButton, Label: fmt.Sprintf("%s:%d", hit.File, hit.Line), TestID: "file-search-hit",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(24),
						Padding: core.Symmetric(0, 6), CornerRadius: 5, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					core.Text{Content: fmt.Sprintf("%d", hit.Line), Style: core.Style{Width: core.Pt(42), TextAlign: core.TextAlignEnd,
						FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
					core.Text{Content: hit.Text, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 11},
						StyleFunc: ui.Colored(colors.Text)},
				}})
		}

		summary := apptext.T("输入关键词后回车，在当前项目里搜索文件内容。")
		switch {
		case busy:
			summary = apptext.T("搜索中…")
		case query != "" && len(hits) == 0:
			summary = apptext.T("没有匹配的内容")
		case len(hits) > 0:
			summary = apptext.T("找到 %d 处，共 %d 个文件", len(hits), len(counts))
		}
		body := []core.Node{core.Text{Content: summary, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted), TestID: "file-search-summary"}}
		if len(rows) > 0 {
			body = append(body, a.scrollStashFor("fileSearchDialog:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(400)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: rows}}}))
		}

		return ui.Dialog{
			Open:         a.fileSearchOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.fileSearchOpen.Set(open) },
			Title:        apptext.T("在文件中搜索"),
			TestID:       "file-search",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(620)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.Input{Value: a.fileSearchQuery.Get, OnChange: a.fileSearchQuery.Set, Placeholder: apptext.T("搜索文件内容…"),
							Label: apptext.T("关键词"), TestID: "file-search-input", AutoFocus: true,
							OnSubmit: func(string) { a.runFileSearch() },
							Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7, FontSize: 12,
								Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}},
					}},
					ui.Button{Text: apptext.T("搜索"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "file-search-go",
						OnPress: a.runFileSearch},
				}},
				core.View{Style: core.Style{Gap: 6}, Children: body},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "file-search-close",
					OnPress: func() { a.fileSearchOpen.Set(false) }},
			},
		}
	})
}
