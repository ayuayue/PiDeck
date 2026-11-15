package main

// The prompt library dialog: categories on the left, a search field and
// the prompts on the right. A prompt goes into the composer, or to the
// clipboard when no session is open.

import (
	"fmt"
	"strings"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
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
				Role:    core.RoleButton, Label: T("提示词 ") + item.Title, TestID: "prompt-row",
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
			Title:        T("提示词库"),
			TestID:       "prompt-library",
			Style:        core.Style{Width: core.Pt(760), Height: core.Pt(620)},
			Children: []core.Node{core.View{Style: core.Style{Direction: core.Row, Height: core.Pt(430), MinHeight: core.Pt(0), Gap: 10},
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
								core.Input{Value: a.promptQuery.Get, OnChange: a.promptQuery.Set, Placeholder: T("搜索标题、正文或标签…"),
									Label: T("搜索提示词"), TestID: "prompt-search", AutoFocus: true,
									Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7,
										Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
										Color: colors.Text(), FontSize: 12}},
							}},
							ui.IconButton{Icon: lucide.BookmarkPlus, Label: T("保存当前草稿为提示词"), Size: 32, IconSize: 14,
								TestID: "prompt-save-draft", OnPress: func() { a.saveDraftPrompt() }},
							ui.IconButton{Icon: lucide.FolderOpen, Label: T("打开提示词目录"), Size: 32, IconSize: 14,
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
				ui.Button{Text: T("提示词商店…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "prompt-store-open",
					OnPress: a.openPromptStore},
				ui.Button{Text: T("导入提示词包…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "prompt-import",
					OnPress: a.openPromptImport},
				ui.Button{Text: T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "prompt-close",
					OnPress: func() { a.promptOpen.Set(false) }},
			},
		}
	})
}

// openPromptImport asks for a shared pack's URL.
func (a *app) openPromptImport() {
	a.promptImportURL.Set("")
	a.promptImportErr.Set("")
	a.promptImportBusy.Set(false)
	a.promptImportOpen.Set(true)
}

// importPromptURL downloads a pack and merges it into the user's prompts.
func (a *app) importPromptURL() {
	if a.promptImportBusy.GetUntracked() {
		return
	}
	url := strings.TrimSpace(a.promptImportURL.GetUntracked())
	if url == "" {
		a.promptImportErr.Set("先填一个链接")
		return
	}
	a.promptImportBusy.Set(true)
	a.promptImportErr.Set("")
	go func() {
		pack, err := fetchPromptPack(url)
		if err == nil {
			var added, skipped int
			added, skipped, err = a.importPromptPack(pack)
			if err == nil {
				a.cx.Post(func() {
					a.promptImportBusy.Set(false)
					a.promptImportOpen.Set(false)
					a.prompts.Set(a.loadPrompts())
					if added == 0 {
						a.toast(ui.ToastInfo, "没有新的提示词", fmt.Sprintf("已跳过 %d 条重复。", skipped))
						return
					}
					a.toast(ui.ToastSuccess, fmt.Sprintf("已导入 %d 条", added), fmt.Sprintf("跳过 %d 条重复。", skipped))
				})
				return
			}
		}
		a.cx.Post(func() {
			a.promptImportBusy.Set(false)
			a.promptImportErr.Set(err.Error())
		})
	}()
}

// promptImportDialog takes a link to a JSON or YAML prompt pack.
func (a *app) promptImportDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		busy := a.promptImportBusy.Get()
		var status core.Node
		if busy {
			status = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text("正在下载并导入…", 11.5, ui.Regular, colors.Muted)}}
		} else if a.promptImportErr.Get() != "" {
			status = core.Text{Content: a.promptImportErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 11, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Danger)}
		}
		return ui.Dialog{
			Open:         a.promptImportOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.promptImportOpen.Set(open) },
			Title:        T("导入提示词包"),
			TestID:       "prompt-import-dialog",
			Style:        core.Style{Width: core.Pt(540)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				core.Text{Content: "填一个 http(s) 链接：JSON 或 YAML，可以是 {prompts:[…]} 或直接一个数组；每条要有 title 和 body（或 prompt）。",
					Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)},
				core.Input{Value: a.promptImportURL.Get, OnChange: a.promptImportURL.Set, Placeholder: "https://…/prompts.json",
					Label: T("提示词包链接"), TestID: "prompt-import-url", AutoFocus: true,
					OnSubmit: func(string) { a.importPromptURL() },
					Style: core.Style{Height: core.Pt(34), Padding: core.Symmetric(0, 10), FontSize: 12, FontFamily: ui.Mono, Color: colors.Text(),
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 7}},
				status,
			}}},
			Footer: []core.Node{
				ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.promptImportOpen.Set(false) }},
				ui.Button{Text: T("导入"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "prompt-import-go",
					Disabled: func() bool { return busy }, OnPress: a.importPromptURL},
			},
		}
	})
}
