//go:build !js && !android && !ios

package workbench

// The skill store's dialog: a link to an index of shared SKILL.md files,
// the skills it lists, and one-click installs into pi's skills folder.

import (
	"path/filepath"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// openSkillStore shows the store with the last index link.
func (a *app) openSkillStore() {
	a.skillStoreURL.Set(a.cfg.SkillIndexURL)
	a.skillStoreList.Set(nil)
	a.skillStoreErr.Set("")
	a.skillStoreBusy.Set(false)
	a.skillStoreInstalling.Set("")
	a.skillStoreDone = map[string]bool{}
	a.skillStoreOpen.Set(true)
}

// loadSkillIndex reads the index at the dialog's link.
func (a *app) loadSkillIndex() {
	if a.skillStoreBusy.GetUntracked() {
		return
	}
	url := strings.TrimSpace(a.skillStoreURL.GetUntracked())
	if url == "" {
		a.skillStoreErr.Set("先填一个索引链接")
		return
	}
	a.skillStoreBusy.Set(true)
	a.skillStoreErr.Set("")
	go func() {
		list, err := fetchSkillIndex(url)
		a.cx.Post(func() {
			a.skillStoreBusy.Set(false)
			if err != nil {
				a.skillStoreErr.Set(err.Error())
				return
			}
			a.skillStoreList.Set(list)
			a.cfg.SkillIndexURL = url
			if a.st != nil {
				a.st.edit(func(c *config) { c.SkillIndexURL = url })
			}
		})
	}()
}

// installSkillEntry downloads one skill into pi's skills folder.
func (a *app) installSkillEntry(e skillIndexEntry) {
	if a.skillStoreInstalling.GetUntracked() != "" {
		return
	}
	a.skillStoreInstalling.Set(e.ID)
	go func() {
		path, err := installSkill(e)
		a.cx.Post(func() {
			a.skillStoreInstalling.Set("")
			if err != nil {
				a.toast(ui.ToastError, "安装技能失败", err.Error())
				return
			}
			if a.skillStoreDone == nil {
				a.skillStoreDone = map[string]bool{}
			}
			a.skillStoreDone[e.ID] = true
			a.resourcesLoaded = false
			a.loadResources(true)
			a.toastAction(ui.ToastSuccess, "已安装技能", e.Name, "打开", func() {
				a.openEditorFile(filepath.Dir(path), path)
			})
		})
	}()
}

// skillStoreDialog draws the store.
func (a *app) skillStoreDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		list := a.skillStoreList.Get()
		busy := a.skillStoreBusy.Get()
		installing := a.skillStoreInstalling.Get()
		var rows []core.Node
		for _, e := range list {
			entry := e
			done := a.skillStoreDone[entry.ID] || skillInstalled(entry.ID)
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
				ui.Icon(lucide.Sparkles, 14, colors.Muted),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: texts},
			}
			if done {
				row = append(row, core.View{Style: core.Style{Padding: core.Symmetric(1, 6), CornerRadius: 4, Background: colors.Inset()},
					Children: []core.Node{ui.Text(apptext.T("已安装"), 9, ui.Medium, colors.Faint)}})
			} else {
				row = append(row, ui.Button{Text: apptext.T("安装"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "skill-store-install-" + entry.ID,
					Disabled: func() bool {
						return installing != ""
					},
					OnPress: func() { a.installSkillEntry(entry) }})
			}
			rows = append(rows, core.View{TestID: "skill-store-entry-" + entry.ID,
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(48),
					Padding: core.Symmetric(4, 6)}, Children: row})
		}
		var status core.Node
		switch {
		case busy:
			status = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text(apptext.T("正在读取索引…"), 11.5, ui.Regular, colors.Muted)}}
		case a.skillStoreErr.Get() != "":
			status = core.Text{Content: a.skillStoreErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 11, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Danger)}
		case len(list) == 0:
			status = core.Text{Content: apptext.T("填一个索引链接，加载后就能安装。索引是 {skills:[{id,name,url}]} 或一个数组，url 指向 SKILL.md。"),
				Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)}
		}
		return ui.Dialog{
			Open:         a.skillStoreOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.skillStoreOpen.Set(open) },
			Title:        apptext.T("技能商店"),
			TestID:       "skill-store",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(660)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				ui.Button{Text: apptext.T("搜索 skills.sh"), TestID: "skill-store-online", Variant: ui.ButtonGhost, Size: ui.SizeSmall, Disabled: a.skillStoreBusy.Get, OnPress: a.searchOnlineSkills},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.Input{Value: a.skillStoreURL.Get, OnChange: a.skillStoreURL.Set, Placeholder: "https://…/skills.json",
							Label: apptext.T("索引链接"), TestID: "skill-store-url", AutoFocus: true,
							OnSubmit: func(string) { a.loadSkillIndex() },
							Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), FontSize: 11.5, FontFamily: viewkit.MonoFont(), Color: colors.Text(),
								Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 7}},
					}},
					ui.Button{Text: apptext.T("加载"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "skill-store-load",
						Disabled: func() bool { return a.skillStoreBusy.Get() }, OnPress: a.loadSkillIndex},
				}},
				status,
				a.scrollStashFor("skillStoreDialog:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(400)}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: rows}}}),
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "skill-store-close",
					OnPress: func() { a.skillStoreOpen.Set(false) }},
			},
		}
	})
}
