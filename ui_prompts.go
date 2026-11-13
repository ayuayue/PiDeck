package main

// The prompt library dialog: categories on the left, a search field and
// the prompts on the right. A prompt goes into the composer, or to the
// clipboard when no session is open.

import (
	"fmt"

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
)

// promptDialog is the library window.
func (a *app) promptDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		list := a.prompts.Get()
		cat := a.promptCat.Get()
		query := a.promptQuery.Get()
		shown := filterPrompts(list, cat, query)
		var cats []core.Node
		addCat := func(id, label string, count int) core.Node {
			on := func() bool { return cat == id }
			return core.View{
				OnPress: func(core.PressEvent) { a.promptCat.Set(id) },
				Role:    core.RoleRadio, Label: label, TestID: "prompt-cat-" + id,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(28),
						Padding: core.Symmetric(0, 8), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
					if on() {
						st.Background = colors.Pressed()
					}
					return st
				},
				Children: []core.Node{
					core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12},
						StyleFunc: ui.Colored(colors.Text)},
					ui.Text(fmt.Sprint(count), 10, ui.Regular, colors.Faint),
				},
			}
		}
		cats = append(cats, addCat("", "全部", len(list)))
		for _, c := range promptCategories(list) {
			count := 0
			for _, p := range list {
				if p.Category == c {
					count++
				}
			}
			cats = append(cats, addCat(c, c, count))
		}
		var rows []core.Node
		for _, p := range shown {
			item := p
			var tagNodes []core.Node
			for _, tag := range item.Tags {
				tagNodes = append(tagNodes, core.View{StyleFunc: func() core.Style {
					return core.Style{Padding: core.Symmetric(0, 6), CornerRadius: 8, Background: colors.Inset()}
				}, Children: []core.Node{core.Text{Content: tag, Style: core.Style{FontSize: 9},
					StyleFunc: ui.Colored(colors.Faint)}}})
			}
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) { a.insertPrompt(item) },
				Role:    core.RoleButton, Label: "提示词 " + item.Title, TestID: "prompt-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 10, Padding: core.Symmetric(8, 8),
						CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()},
						Active: &core.Style{Background: colors.Pressed()}, Transition: pressMotion}
				},
				Children: []core.Node{
					ui.Icon(lucide.ScrollText, 13, colors.Faint),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 3}, Children: []core.Node{
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
							core.Text{Content: item.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
								Style:     core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, FontWeight: ui.Medium},
								StyleFunc: ui.Colored(colors.Text)},
							ui.Text(item.Category, 9.5, ui.Regular, colors.Faint),
						}},
						core.Text{Content: firstLine(item.Body, 120), MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Muted)},
						core.Show{When: func() bool { return len(tagNodes) > 0 }, Then: func(*core.Scope) core.Node {
							return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 4}, Children: tagNodes}
						}},
					}},
				},
			})
		}
		if len(rows) == 0 {
			rows = append(rows, core.View{Style: core.Style{Padding: core.Symmetric(20, 8), AlignItems: core.AlignCenter},
				Children: []core.Node{ui.Text("没有匹配的提示词", 12, ui.Regular, colors.Faint)}})
		}
		return ui.Dialog{
			Open:         a.promptOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.promptOpen.Set(open) },
			Title:        "提示词库",
			TestID:       "prompt-library",
			Style:        core.Style{Width: core.Pt(760), Height: core.Pt(560)},
			Children: []core.Node{core.View{Style: core.Style{Direction: core.Row, FlexGrow: 1, MinHeight: core.Pt(0), Gap: 10},
				Children: []core.Node{
					core.View{StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(156), FlexShrink: 0, Padding: core.Symmetric(6, 2), Gap: 1,
							Background: colors.Inset(), CornerRadius: 8}
					}, Children: []core.Node{core.Scroll{Style: ui.FillRest, Children: []core.Node{
						core.View{Style: core.Style{Gap: 1}, Children: cats},
					}}}},
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 6}, Children: []core.Node{
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
							core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
								core.Input{Value: a.promptQuery.Get, OnChange: a.promptQuery.Set, Placeholder: "搜索标题、正文或标签…",
									Label: "搜索提示词", TestID: "prompt-search", AutoFocus: true,
									Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7,
										Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
										Color: colors.Text(), FontSize: 12}},
							}},
							ui.IconButton{Icon: lucide.BookmarkPlus, Label: "保存当前草稿为提示词", Size: 32, IconSize: 14,
								TestID: "prompt-save-draft", OnPress: func() { a.saveDraftPrompt() }},
							ui.IconButton{Icon: lucide.FolderOpen, Label: "打开提示词目录", Size: 32, IconSize: 14,
								TestID: "prompt-open-dir", OnPress: func() {
									a.promptOpen.Set(false)
									a.openResourcesDir(a.promptsDir())
								}},
						}},
						core.Scroll{Style: ui.FillRest, Children: []core.Node{
							core.View{Style: core.Style{Gap: 2}, Children: rows},
						}},
					}},
				}}},
			Footer: []core.Node{
				ui.Button{Text: "关闭", Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "prompt-close",
					OnPress: func() { a.promptOpen.Set(false) }},
			},
		}
	})
}
