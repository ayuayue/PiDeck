//go:build !js && !android && !ios

package workbench

// The prompt store's dialog: a link to an index of shared packs, the packs
// it lists, and one-click imports into the user's prompt library.

import (
	"fmt"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// openPromptStore shows the store with the last index link.
func (a *app) openPromptStore() {
	a.promptStoreURL.Set(a.cfg.PromptIndexURL)
	a.promptStoreList.Set(nil)
	a.promptStoreErr.Set("")
	a.promptStoreBusy.Set(false)
	a.promptStoreInstalling.Set("")
	a.promptStoreDone = map[string]bool{}
	a.promptStoreOpen.Set(true)
}

// loadPromptIndex reads the index at the dialog's link.
func (a *app) loadPromptIndex() {
	if a.promptStoreBusy.GetUntracked() {
		return
	}
	url := strings.TrimSpace(a.promptStoreURL.GetUntracked())
	if url == "" {
		a.promptStoreErr.Set("先填一个索引链接")
		return
	}
	a.promptStoreBusy.Set(true)
	a.promptStoreErr.Set("")
	go func() {
		list, err := fetchPromptIndex(url)
		a.cx.Post(func() {
			a.promptStoreBusy.Set(false)
			if err != nil {
				a.promptStoreErr.Set(err.Error())
				return
			}
			a.promptStoreList.Set(list)
			a.cfg.PromptIndexURL = url
			if a.st != nil {
				a.st.edit(func(c *config) { c.PromptIndexURL = url })
			}
		})
	}()
}

// installPromptPack downloads and merges one pack.
func (a *app) installPromptPack(e promptIndexEntry) {
	if a.promptStoreInstalling.GetUntracked() != "" {
		return
	}
	a.promptStoreInstalling.Set(e.ID)
	go func() {
		added, skipped, err := a.installPromptIndexEntry(e)
		a.cx.Post(func() {
			a.promptStoreInstalling.Set("")
			if err != nil {
				a.toast(ui.ToastError, "导入失败", err.Error())
				return
			}
			if a.promptStoreDone == nil {
				a.promptStoreDone = map[string]bool{}
			}
			a.promptStoreDone[e.ID] = true
			a.prompts.Set(a.loadPrompts())
			if added == 0 {
				a.toast(ui.ToastInfo, "没有新的提示词", fmt.Sprintf("已跳过 %d 条重复。", skipped))
				return
			}
			a.toast(ui.ToastSuccess, fmt.Sprintf("已导入 %d 条", added), fmt.Sprintf("跳过 %d 条重复。", skipped))
		})
	}()
}

// importOfficialPrompts merges PiDeck's bundled template pack.
func (a *app) importOfficialPrompts() {
	if a.promptStoreBusy.GetUntracked() || a.promptStoreInstalling.GetUntracked() != "" {
		return
	}
	a.promptStoreInstalling.Set("official")
	go func() {
		pack, err := officialPromptPack()
		added, skipped := 0, 0
		if err == nil {
			added, skipped, err = a.importPromptPack(pack)
		}
		var list []promptItem
		if err == nil {
			list = a.loadPrompts()
		}
		a.cx.Post(func() {
			a.promptStoreInstalling.Set("")
			if err != nil {
				a.toast(ui.ToastError, "导入失败", err.Error())
				return
			}
			a.prompts.Set(list)
			if added == 0 {
				a.toast(ui.ToastInfo, "没有新的提示词", fmt.Sprintf("已跳过 %d 条重复。", skipped))
				return
			}
			a.toast(ui.ToastSuccess, fmt.Sprintf("已导入 %d 条", added), fmt.Sprintf("跳过 %d 条重复。", skipped))
		})
	}()
}

// installOfficialPromptsToPi installs the bundled templates as pi commands.
func (a *app) installOfficialPromptTemplates() {
	if a.promptStoreBusy.GetUntracked() || a.promptStoreInstalling.GetUntracked() != "" {
		return
	}
	a.promptStoreInstalling.Set("official-pi")
	go func() {
		added, skipped := 0, 0
		pack, err := officialPromptPack()
		if err == nil {
			added, skipped, err = installOfficialPromptsToPi(pack)
		}
		a.cx.Post(func() {
			a.promptStoreInstalling.Set("")
			if err != nil {
				a.toast(ui.ToastError, "安装提示词失败", err.Error())
				return
			}
			if added == 0 {
				a.toast(ui.ToastInfo, "已安装到 pi 提示词", fmt.Sprintf("跳过 %d 个已有文件。", skipped))
				return
			}
			a.toast(ui.ToastSuccess, "已安装到 pi 提示词", fmt.Sprintf("新增 %d 个，跳过 %d 个已有文件。", added, skipped))
		})
	}()
}

// promptStoreDialog draws the store.
func (a *app) promptStoreDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		list := a.promptStoreList.Get()
		busy := a.promptStoreBusy.Get()
		installing := a.promptStoreInstalling.Get()
		var rows []core.Node
		for _, e := range list {
			entry := e
			done := a.promptStoreDone[entry.ID]
			meta := entry.Author
			texts := []core.Node{
				core.Text{Content: entry.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
			}
			if entry.Description != "" {
				texts = append(texts, core.Text{Content: entry.Description, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Muted)})
			}
			if meta != "" {
				texts = append(texts, core.Text{Content: meta, MaxLines: 1,
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)})
			}
			row := []core.Node{
				ui.Icon(lucide.Library, 14, colors.Muted),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: texts},
			}
			if done {
				row = append(row, core.View{Style: core.Style{Padding: core.Symmetric(1, 6), CornerRadius: 4, Background: colors.Inset()},
					Children: []core.Node{ui.Text(apptext.T("已导入"), 9, ui.Medium, colors.Faint)}})
			} else {
				row = append(row, ui.Button{Text: apptext.T("导入"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "prompt-store-install-" + entry.ID,
					Disabled: func() bool {
						return installing != ""
					},
					OnPress: func() { a.installPromptPack(entry) }})
			}
			rows = append(rows, core.View{TestID: "prompt-store-entry-" + entry.ID,
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(48),
					Padding: core.Symmetric(4, 6)}, Children: row})
		}
		var status core.Node
		switch {
		case busy:
			status = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text(apptext.T("正在读取索引…"), 11.5, ui.Regular, colors.Muted)}}
		case a.promptStoreErr.Get() != "":
			status = core.Text{Content: a.promptStoreErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 11, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Danger)}
		case len(list) == 0:
			status = core.Text{Content: apptext.T("填一个索引链接，加载后就能导入。索引是 {packs:[{id,name,url}]} 或一个数组。"),
				Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)}
		}
		return ui.Dialog{
			Open:         a.promptStoreOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.promptStoreOpen.Set(open) },
			Title:        apptext.T("提示词商店"),
			TestID:       "prompt-store",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(660)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: []core.Node{
					ui.Button{Text: "prompts.chat", Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "prompt-source-community", OnPress: func() { a.promptStoreURL.Set("https://prompts.chat"); a.loadPromptIndex() }},
					ui.Button{Text: apptext.T("中文在线库"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "prompt-source-chinese", Disabled: a.promptStoreBusy.Get, OnPress: a.importChinesePrompts},
					ui.Button{Text: apptext.T("官方模板"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "prompt-source-official",
						Disabled: func() bool { return a.promptStoreBusy.Get() || a.promptStoreInstalling.Get() != "" },
						OnPress:  a.importOfficialPrompts},
					ui.Button{Text: apptext.T("安装到 pi 提示词"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "prompt-install-pi",
						Disabled: func() bool { return a.promptStoreBusy.Get() || a.promptStoreInstalling.Get() != "" },
						OnPress:  a.installOfficialPromptTemplates},
				}},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.Input{Value: a.promptStoreURL.Get, OnChange: a.promptStoreURL.Set, Placeholder: "https://…/prompts.json",
							Label: apptext.T("索引链接"), TestID: "prompt-store-url", AutoFocus: true,
							OnSubmit: func(string) { a.loadPromptIndex() },
							Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), FontSize: 11.5, FontFamily: viewkit.MonoFont(), Color: colors.Text(),
								Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 7}},
					}},
					ui.Button{Text: apptext.T("加载"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "prompt-store-load",
						Disabled: func() bool { return a.promptStoreBusy.Get() }, OnPress: a.loadPromptIndex},
				}},
				status,
				a.scrollStashFor("promptStoreDialog:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(400)}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: rows}}}),
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "prompt-store-close",
					OnPress: func() { a.promptStoreOpen.Set(false) }},
			},
		}
	})
}
