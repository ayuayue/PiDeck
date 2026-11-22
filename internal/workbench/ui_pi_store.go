//go:build !js && !android && !ios

package workbench

// The extension store's dialog: installed packages from pi, pi.dev search,
// and one confirmed action at a time.

import (
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// piStoreTestID keeps a package source usable in a stable control ID.
func piStoreTestID(source string) string {
	return strings.NewReplacer(":", "-", "/", "-", "@", "-", "\\", "-", " ", "-").Replace(source)
}

// piPackageInstalled reports whether a catalog item is already installed.
func piPackageInstalled(installed []piPackage, item piCatalogItem) bool {
	for _, pkg := range installed {
		if strings.EqualFold(pkg.Source, item.InstallSource) || strings.EqualFold(pkg.Source, "npm:"+item.Name) {
			return true
		}
	}
	return false
}

// piExtensionStoreDialog draws the store.
func (a *app) piExtensionStoreDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		items := a.piStoreList.Get()
		installed := a.piStoreInstalled.Get()
		busy := a.piStoreBusy.Get()
		acting := a.piStoreActing.Get()
		page, last := a.piStorePage.Get(), a.piStoreLast.Get()

		var installedRows []core.Node
		for _, pkg := range installed {
			p := pkg
			scope := apptext.T("用户")
			if p.Scope == "project" {
				scope = apptext.T("项目")
			}
			installedRows = append(installedRows, core.View{
				TestID: "pi-store-installed-" + piStoreTestID(p.Source),
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(42),
					Padding: core.Symmetric(3, 6)},
				Children: []core.Node{
					ui.Icon(lucide.Blocks, 13, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: p.Source, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11}, StyleFunc: ui.Colored(colors.Text)},
						core.Show{When: func() bool { return p.Path != "" }, Then: func(*core.Scope) core.Node {
							return core.Text{Content: shortPath(p.Path, 58), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9}, StyleFunc: ui.Colored(colors.Faint)}
						}},
					}},
					core.View{Style: core.Style{Padding: core.Symmetric(1, 6), CornerRadius: 4, Background: colors.Inset()},
						Children: []core.Node{ui.Text(scope, 9, ui.Medium, colors.Faint)}},
					ui.Button{Text: apptext.T("更新"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						TestID:   "pi-store-update-" + piStoreTestID(p.Source),
						Busy:     func() bool { return acting == "update:"+p.Source },
						Disabled: func() bool { return acting != "" },
						OnPress:  func() { a.updatePiPackage(p) }},
					ui.Button{Text: apptext.T("卸载"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						TestID:   "pi-store-remove-" + piStoreTestID(p.Source),
						Busy:     func() bool { return acting == p.Source },
						Disabled: func() bool { return acting != "" },
						OnPress:  func() { a.confirmRemovePiPackage(p) }},
				}})
		}

		var rows []core.Node
		for _, item := range items {
			it := item
			meta := strings.TrimSpace(it.Author)
			if meta == "" {
				meta = "pi.dev"
			}
			if len(it.Types) > 0 {
				meta += " · " + it.Types[0]
			}
			texts := []core.Node{
				core.Text{Content: it.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
			}
			if it.Description != "" {
				texts = append(texts, core.Text{Content: it.Description, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Muted)})
			}
			texts = append(texts, core.Text{Content: meta, MaxLines: 1,
				Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)})

			controls := []core.Node{
				ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					TestID:  "pi-store-open-" + piStoreTestID(it.Name),
					OnPress: func() { a.cx.OpenURL(it.PageURL, nil) }},
			}
			if piPackageInstalled(installed, it) {
				controls = append(controls, core.View{Style: core.Style{Padding: core.Symmetric(1, 6), CornerRadius: 4, Background: colors.Inset()},
					Children: []core.Node{ui.Text(apptext.T("已安装"), 9, ui.Medium, colors.Faint)}})
			} else {
				controls = append(controls, ui.Button{Text: apptext.T("安装"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID:   "pi-store-install-" + piStoreTestID(it.Name),
					Busy:     func() bool { return acting == it.InstallSource },
					Disabled: func() bool { return acting != "" || it.InstallSource == "" },
					OnPress:  func() { a.confirmInstallPiPackage(it) }})
			}
			rows = append(rows, core.View{
				TestID: "pi-store-row-" + piStoreTestID(it.Name),
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(52),
					Padding: core.Symmetric(4, 6)},
				Children: []core.Node{
					ui.Icon(lucide.Blocks, 14, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: texts},
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: controls},
				}})
		}

		var status core.Node
		switch {
		case busy:
			status = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text(apptext.T("正在读取扩展商店…"), 11.5, ui.Regular, colors.Muted)}}
		case a.piStoreErr.Get() != "":
			status = core.Text{Content: a.piStoreErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 11, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Danger)}
		case len(items) == 0:
			status = core.Text{Content: apptext.T("没有找到扩展。"),
				Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)}
		}

		var pager core.Node
		if last > 1 {
			pager = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Button{Text: apptext.T("上一页"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					TestID: "pi-store-prev", Disabled: func() bool { return busy || page <= 1 },
					OnPress: func() { a.loadPiCatalog(page - 1) }},
				ui.Text(apptext.T("第 %d / %d 页", page, last), 10, ui.Regular, colors.Faint),
				ui.Button{Text: apptext.T("下一页"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					TestID: "pi-store-next", Disabled: func() bool { return busy || page >= last },
					OnPress: func() { a.loadPiCatalog(page + 1) }},
			}}
		}

		sections := []core.Node{}
		if a.piStoreInstalledErr.Get() != "" {
			sections = append(sections, core.Text{Content: a.piStoreInstalledErr.Get(), MaxLines: 2,
				Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Danger)})
		}
		if len(installedRows) > 0 {
			sections = append(sections, core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
				core.Text{Content: apptext.T("已安装"), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, LetterSpacing: 0.6},
					StyleFunc: ui.Colored(colors.Faint)},
				core.View{Style: core.Style{Gap: 1}, Children: installedRows},
			}})
		}
		sections = append(sections, core.View{Style: core.Style{Gap: 1}, Children: rows})

		footer := []core.Node{}
		if len(installed) > 0 {
			footer = append(footer, ui.Button{Text: apptext.T("更新全部"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
				TestID: "pi-store-update-all", Busy: func() bool { return acting == "update" },
				Disabled: func() bool { return acting != "" }, OnPress: a.confirmUpdatePiPackages})
		}
		footer = append(footer, ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			TestID: "pi-store-close", OnPress: func() { a.closePiExtensionStore() }})

		return ui.Dialog{
			Open: a.piStoreOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) {
				if open {
					a.piStoreOpen.Set(true)
					return
				}
				a.closePiExtensionStore()
			},
			Title:  apptext.T("扩展商店"),
			TestID: "pi-store",
			Style:  core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(680)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.Input{Value: a.piStoreQuery.Get, OnChange: a.piStoreQuery.Set,
							Placeholder: apptext.T("搜索 pi.dev 扩展"), Label: apptext.T("搜索 pi.dev 扩展"),
							TestID: "pi-store-query", AutoFocus: true,
							OnSubmit: func(string) { a.searchPiCatalog() },
							Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), FontSize: 11.5, Color: colors.Text(),
								Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 7}},
					}},
					ui.Button{Text: apptext.T("搜索"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "pi-store-search", Disabled: func() bool { return busy }, OnPress: a.searchPiCatalog},
				}},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
					ui.Switch{Checked: func() bool { return a.piStoreLocal.Get() }, Label: apptext.T("安装到当前项目"),
						TestID: "pi-store-local", Disabled: func() bool { return a.piStoreProjectDir() == "" },
						OnChange: func(on bool) {
							a.piStoreLocal.Set(on)
							a.loadPiInstalled()
						}},
					core.Text{ContentFunc: func() string {
						dir := a.piStoreProjectDir()
						if dir == "" {
							return apptext.T("没有打开项目")
						}
						return apptext.T("当前项目：%s", shortPath(dir, 50))
					}, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
				}},
				status,
				pager,
				core.Scroll{Style: core.Style{MaxHeight: core.Pt(420)}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 8}, Children: sections}}},
			}}},
			Footer: footer,
		}
	})
}
