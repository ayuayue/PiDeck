//go:build !js && !android && !ios

package workbench

// The import dialog: one tab per tool whose history this app can read, with
// the sessions of that tool in it, so each store is picked and imported on
// its own instead of every tool's sessions in one heap.

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/sessionimport"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// importTab is one source's tab above the list, or the one that holds them
// all.
func (a *app) importTab(label, key string, count, pending int) core.Node {
	colors := ui.ColorsOf(a.cx)
	on := func() bool { return a.impOnly.Get() == key }
	testID := "import-tab-all"
	if key != "" {
		testID = "import-tab-" + key
	}
	return core.View{OnPress: func(core.PressEvent) { a.setImportTab(key) },
		Role: core.RoleTab, Label: label, TestID: testID,
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(30),
				Padding: core.Symmetric(0, 10), CornerRadius: 7, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}}
			if on() {
				st.Background = colors.Pressed()
				st.FontWeight = ui.Semibold
			}
			return st
		},
		Children: []core.Node{
			core.Text{Content: label, MaxLines: 1, Style: core.Style{FontSize: 12},
				StyleFunc: func() core.Style {
					weight := ui.Regular
					if on() {
						weight = ui.Semibold
					}
					return core.Style{Color: colors.Text(), FontWeight: weight}
				}},
			ui.Text(fmt.Sprint(count), 9.5, ui.Medium, colors.Faint),
			core.Show{When: func() bool { return pending > 0 && !on() }, Then: func(*core.Scope) core.Node {
				return core.View{Style: core.Style{Width: core.Pt(5), Height: core.Pt(5), CornerRadius: 3},
					StyleFunc: ui.Filled(colors.Accent)}
			}},
		}}
}

// importStateBadge shows where a row stands.
func importStateBadge(state sessionimport.State) core.Node {
	switch state {
	case sessionimport.Current:
		return ui.Badge{Text: apptext.T("已导入"), Variant: ui.BadgeNeutral}
	case sessionimport.Outdated:
		return ui.Badge{Text: apptext.T("有更新"), Variant: ui.BadgeWarn}
	}
	return ui.Badge{Text: apptext.T("新"), Variant: ui.BadgeAccent}
}

// importRowView is one session in the list.
func (a *app) importRowView(row sessionimport.Row, here bool) core.Node {
	colors := ui.ColorsOf(a.cx)
	key := row.Key()
	source := sessionimport.SourceByKey(row.Source)
	label := row.Source
	if source != nil {
		label = source.Label
	}
	pickable := row.State != sessionimport.Current
	where := row.Cwd
	if where == "" {
		where = apptext.T("没有记录原目录")
	}
	return core.View{TestID: "import-row",
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(40),
				Padding: core.Symmetric(3, 6), CornerRadius: 7}
			if a.isImportSelected(key) {
				st.Background = colors.Inset()
			}
			return st
		},
		Children: []core.Node{
			ui.Checkbox{Checked: func() bool { return a.isImportSelected(key) },
				Disabled: func() bool { return !pickable }, Label: row.Title,
				OnChange: func(bool) { a.toggleImportRow(key) }, TestID: "import-check"},
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
				core.Text{Content: row.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 12.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Text)},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Text(label, 9.5, ui.Medium, colors.Faint),
					core.Show{When: func() bool { return here }, Then: func(*core.Scope) core.Node {
						return ui.Badge{Text: apptext.T("本项目"), Variant: ui.BadgeAccent}
					}},
					core.Text{Content: where, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, FlexShrink: 1, MinWidth: core.Pt(0)},
						StyleFunc: ui.Colored(colors.Faint)},
				}},
			}},
			core.Show{When: func() bool { return row.Err != "" }, Then: func(*core.Scope) core.Node {
				return ui.IconOf(lucide.CircleAlert, 12, colors.Danger)
			}},
			core.Text{Content: viewkit.WhenText(row.Updated, a.cx.Now()), MaxLines: 1,
				Style:     core.Style{Width: core.Pt(56), TextAlign: core.TextAlignRight, FontFamily: viewkit.MonoFont(), FontSize: 9.5},
				StyleFunc: ui.Colored(colors.Faint)},
			importStateBadge(row.State),
		}}
}

// importEmpty explains an empty list: still scanning, nothing on this
// machine, or nothing matching the filter.
func (a *app) importEmpty(rows []sessionimport.Row) core.Node {
	colors := ui.ColorsOf(a.cx)
	if a.impScanning.Get() {
		return core.View{Style: core.Style{Gap: 8, Padding: core.All(10)}, Children: []core.Node{
			core.Text{Content: apptext.T("正在读各家的会话库…"), Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
			a.projectLoadingRows()[0], a.projectLoadingRows()[1], a.projectLoadingRows()[2],
		}}
	}
	msg := apptext.T("这些工具的会话库里还没有可导入的会话。")
	if len(rows) == 0 && (a.impOnly.Get() != "" || strings.TrimSpace(a.impQuery.Get()) != "") {
		msg = apptext.T("没有匹配的会话，换个关键词或来源试试。")
	}
	var labels []string
	for _, s := range sessionimport.Sources {
		labels = append(labels, s.Label)
	}
	return core.View{Style: core.Style{Gap: 8, Padding: core.All(10)}, Children: []core.Node{
		core.Text{Content: msg, Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
		core.Text{Content: apptext.T("会读：") + strings.Join(labels, "、"), MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FontSize: 10.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
	}}
}

// importTargetLine names the scoped project or the global entry's original
// directories. Project imports keep their scope for the whole dialog.
func (a *app) importTargetLine() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.Dynamic(func(cx *core.Scope) core.Node {
		ws := a.importTargetProject()
		if ws == nil {
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.IconOf(lucide.FolderInput, 12, colors.Faint),
				core.Text{Content: apptext.T("导入到：每个会话自己的原目录（原目录不在时用当前项目）"), MaxLines: 1,
					EllipsizeMode: core.EllipsizeTail, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
			}}
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			ui.IconOf(lucide.FolderInput, 12, colors.Accent),
			core.Text{Content: fmt.Sprintf(apptext.T("导入到「%s」"), ws.label()), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontSize: 11, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
		}}
	})
}

// importFooter is the dialog's bottom: how far a run has got, or the ways
// to start one.
func (a *app) importFooter() []core.Node {
	colors := ui.ColorsOf(a.cx)
	if a.impBusy.Get() {
		done, total := a.impDone.Get(), a.impTotal.Get()
		pct := func() float32 {
			if total <= 0 {
				return 0
			}
			return float32(done) * 100 / float32(total)
		}
		label := fmt.Sprintf(apptext.T("正在导入 %d / %d"), done, total)
		if failed := a.impFailed.Get(); failed > 0 {
			label += fmt.Sprintf(apptext.T(" · 失败 %d"), failed)
		}
		return []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 5}, Children: []core.Node{
				ui.Progress{Value: pct, Label: label, TestID: "import-progress"},
				core.Text{Content: label, MaxLines: 1, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
			}},
		}
	}
	picked := len(a.importPicked())
	runText := apptext.T("导入")
	if picked > 0 {
		runText = fmt.Sprintf(apptext.T("导入 %d 个"), picked)
	}
	var elsewhere []core.Node
	if n := a.importPickedElsewhere(); n > 0 {
		elsewhere = append(elsewhere, core.Text{Content: fmt.Sprintf(apptext.T("另有 %d 个在别的来源"), n), MaxLines: 1,
			Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)})
	}
	return append([]core.Node{
		ui.Button{Text: apptext.T("选择文件…"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "import-file",
			OnPress: func() { a.openPicker("import") }},
		ui.Button{Text: apptext.T("重新扫描"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "import-rescan",
			OnPress: func() { a.scanImports() }},
		core.View{Style: core.Style{FlexGrow: 1, Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, JustifyContent: core.JustifyEnd},
			Children: elsewhere},
		ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "import-close",
			OnPress: func() { a.impOpen.Set(false) }},
		ui.Button{Text: runText, Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "import-run",
			Disabled: func() bool { return picked == 0 }, OnPress: func() { a.importChosen() }},
	}, elsewhere...)
}

// importDialog is the dialog's shell. Only opening and closing it rebuilds
// this: the body, the tabs and the footer are their own readers, so picking
// a tab or a row never remounts the dialog (which would replay its fade and
// pop).
func (a *app) importDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.langRev.Get()
		return ui.Dialog{
			Open:         a.impOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.impOpen.Set(open) },
			Title:        apptext.T("导入会话"),
			Description:  apptext.T("从 Claude Code、Codex、Cursor 等工具的历史里挑出会话，转换后复制到本应用自己的会话目录：原文件不动。"),
			TestID:       "import-dialog",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(640)},
			Children:     []core.Node{a.importBody()},
			Footer:       []core.Node{a.importFooterBar()},
		}
	})
}

// importFooterBar is the footer as one row that follows the run.
func (a *app) importFooterBar() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.impBusy.Get()
		_ = a.impDone.Get()
		_ = a.impTotal.Get()
		_ = a.impFailed.Get()
		_ = a.impSel.Get()
		_ = a.impRows.Get()
		_ = a.impOnly.Get()
		_ = a.impQuery.Get()
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8,
			Width: core.Pct(100)}, Children: a.importFooter()}
	})
}

// importBody follows the scan, the open tab, the search and the picks.
func (a *app) importBody() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.impRows.Get()
		_ = a.impSel.Get()
		_ = a.impScanning.Get()
		_ = a.impOnly.Get()
		_ = a.impQuery.Get()
		_ = a.impProject.Get()
		rows := a.importVisibleRows()
		total, pending := a.importSourceCounts()

		tabs := []core.Node{a.importTab(apptext.T("全部"), "", len(a.impRows.Get()), 0)}
		for _, src := range sessionimport.Sources {
			if total[src.Key] == 0 {
				continue
			}
			tabs = append(tabs, a.importTab(src.Label, src.Key, total[src.Key], pending[src.Key]))
		}
		target := strings.TrimSpace(a.impProject.Get())

		search := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6,
			Height: core.Pt(28), Padding: core.Symmetric(0, 8), CornerRadius: 7, Background: colors.Field(),
			BorderWidth: 1, BorderColor: colors.FieldBorder(), FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
			ui.IconOf(lucide.Search, 12, colors.Faint),
			core.Input{Value: a.impQuery.Get, OnChange: a.impQuery.Set, Placeholder: apptext.T("搜索标题或目录"),
				Label: apptext.T("搜索可导入会话"), TestID: "import-search",
				Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 12, LineHeight: 18, Color: colors.Text()},
				StyleFunc: func() core.Style {
					return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
				}},
		}}

		var list []core.Node
		if len(rows) == 0 {
			list = append(list, a.importEmpty(rows))
		} else {
			const limit = 400
			shown := rows
			if len(shown) > limit {
				shown = shown[:limit]
			}
			nodes := make([]core.Node, 0, len(shown))
			for _, row := range shown {
				nodes = append(nodes, a.importRowView(row, target != "" && pathKey(row.Cwd) == pathKey(target)))
			}
			if hidden := len(rows) - len(shown); hidden > 0 {
				nodes = append(nodes, core.Text{Content: fmt.Sprintf(apptext.T("还有 %d 个未列出，用搜索或来源筛选"), hidden),
					Style: core.Style{FontSize: 10.5, Padding: core.All(6)}, StyleFunc: ui.Colored(colors.Faint)})
			}
			list = append(list, a.scrollStashFor("importBody:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(340)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: nodes}}}))
		}

		return core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
			a.importTargetLine(),
			// One tab per tool: each store is picked and imported on its own,
			// rather than every tool's sessions in one heap.
			a.scrollStashFor("importBody:2").Bind(cx, core.Scroll{Horizontal: true, HideIndicator: true, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2}, Children: tabs}}}),
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				search,
				ui.Button{Text: apptext.T("全选"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "import-select-all",
					OnPress: func() { a.selectImportRows() }},
			}},
			core.View{Style: core.Style{Gap: 2}, Children: list},
		}}
	})
}
