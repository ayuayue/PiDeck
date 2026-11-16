//go:build !js && !android && !ios

package main

// The import dialog: what the other agents' stores hold, per session, with
// a pick and a progress bar. It is one place for every source, because a
// user remembers "that session in Claude", not which folder it lives in.

import (
	"fmt"
	"strings"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// importChip is one source filter above the list.
func (a *app) importChip(label, key string, count int) core.Node {
	colors := ui.ColorsOf(a.cx)
	on := func() bool { return a.impOnly.Get() == key }
	return core.View{OnPress: func(core.PressEvent) { a.impOnly.Set(key) },
		Role: core.RoleRadio, Label: label, TestID: "import-source-" + key,
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(24),
				Padding: core.Symmetric(0, 9), CornerRadius: 12, BorderWidth: 1, BorderColor: colors.Border(),
				Transition: pressMotion, Hover: &core.Style{Background: colors.Hover()}}
			if on() {
				st.Background = colors.Pressed()
				st.BorderColor = colors.Text()
			}
			return st
		},
		Children: []core.Node{
			ui.Text(label, 11.5, ui.Regular, colors.Text),
			ui.Text(fmt.Sprint(count), 9.5, ui.Medium, colors.Faint),
		}}
}

// importStateBadge shows where a row stands.
func importStateBadge(state importState) core.Node {
	switch state {
	case importCurrent:
		return ui.Badge{Text: T("已导入"), Variant: ui.BadgeNeutral}
	case importOutdated:
		return ui.Badge{Text: T("有更新"), Variant: ui.BadgeWarn}
	}
	return ui.Badge{Text: T("新"), Variant: ui.BadgeAccent}
}

// importRowView is one session in the list.
func (a *app) importRowView(row importRow) core.Node {
	colors := ui.ColorsOf(a.cx)
	key := row.key()
	source := importSourceByKey(row.Source)
	label := row.Source
	if source != nil {
		label = source.Label
	}
	pickable := row.State != importCurrent
	where := row.Cwd
	if where == "" {
		where = T("没有记录原目录")
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
					core.Text{Content: where, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, FlexShrink: 1, MinWidth: core.Pt(0)},
						StyleFunc: ui.Colored(colors.Faint)},
				}},
			}},
			core.Show{When: func() bool { return row.Err != "" }, Then: func(*core.Scope) core.Node {
				return ui.IconOf(lucide.CircleAlert, 12, colors.Danger)
			}},
			core.Text{Content: whenText(row.Updated, a.cx.Now()), MaxLines: 1,
				Style: core.Style{Width: core.Pt(56), TextAlign: core.TextAlignRight, FontFamily: ui.Mono, FontSize: 9.5},
				StyleFunc: ui.Colored(colors.Faint)},
			importStateBadge(row.State),
		}}
}

// importEmpty explains an empty list: still scanning, nothing on this
// machine, or nothing matching the filter.
func (a *app) importEmpty(rows []importRow) core.Node {
	colors := ui.ColorsOf(a.cx)
	if a.impScanning.Get() {
		return core.View{Style: core.Style{Gap: 8, Padding: core.All(10)}, Children: []core.Node{
			core.Text{Content: T("正在读各家的会话库…"), Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
			a.projectLoadingRows()[0], a.projectLoadingRows()[1], a.projectLoadingRows()[2],
		}}
	}
	msg := T("这些工具的会话库里还没有可导入的会话。")
	if len(rows) == 0 && (a.impOnly.Get() != "" || strings.TrimSpace(a.impQuery.Get()) != "") {
		msg = T("没有匹配的会话，换个关键词或来源试试。")
	}
	var roots []string
	for _, s := range importSources {
		roots = append(roots, s.Label)
	}
	return core.View{Style: core.Style{Gap: 8, Padding: core.All(10)}, Children: []core.Node{
		core.Text{Content: msg, Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
		core.Text{Content: T("会读：") + strings.Join(roots, "、"), MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FontSize: 10.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
	}}
}

// importFooter is the dialog's bottom: how far a run has got, or the ways
// to start one.
func (a *app) importFooter(rows []importRow) []core.Node {
	colors := ui.ColorsOf(a.cx)
	if a.impBusy.Get() {
		done, total := a.impDone.Get(), a.impTotal.Get()
		pct := func() float32 {
			if total <= 0 {
				return 0
			}
			return float32(done) * 100 / float32(total)
		}
		label := fmt.Sprintf(T("正在导入 %d / %d"), done, total)
		if failed := a.impFailed.Get(); failed > 0 {
			label += fmt.Sprintf(T(" · 失败 %d"), failed)
		}
		return []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 5}, Children: []core.Node{
				ui.Progress{Value: pct, Label: label, TestID: "import-progress"},
				core.Text{Content: label, MaxLines: 1, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
			}},
		}
	}
	picked := len(a.importPicked())
	runText := T("导入")
	if picked > 0 {
		runText = fmt.Sprintf(T("导入 %d 个"), picked)
	}
	return []core.Node{
		ui.Button{Text: T("选择文件…"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "import-file",
			OnPress: func() { a.openPicker("import") }},
		ui.Button{Text: T("重新扫描"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "import-rescan",
			OnPress: func() { a.scanImports() }},
		core.View{Style: core.Style{FlexGrow: 1}},
		ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "import-close",
			OnPress: func() { a.impOpen.Set(false) }},
		ui.Button{Text: runText, Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "import-run",
			Disabled: func() bool { return picked == 0 }, OnPress: func() { a.importChosen() }},
	}
}

// importDialog is the whole dialog.
func (a *app) importDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.langRev.Get()
		// The dialog follows what the scan found, what is picked, and how a
		// run is going: each of these changes the rows, the button or the
		// progress line.
		_ = a.impRows.Get()
		_ = a.impSel.Get()
		_ = a.impScanning.Get()
		_ = a.impBusy.Get()
		_ = a.impDone.Get()
		_ = a.impTotal.Get()
		_ = a.impOnly.Get()
		_ = a.impQuery.Get()
		rows := a.importVisibleRows()
		total, pending := a.importSourceCounts()
		pickedCount := 0
		for _, row := range a.impRows.Get() {
			if a.isImportSelected(row.key()) && row.State != importCurrent {
				pickedCount++
			}
		}

		chips := []core.Node{a.importChip(T("全部"), "", len(a.impRows.Get()))}
		for _, s := range a.importSourcesWithRows() {
			chips = append(chips, a.importChip(s.Label, s.Key, total[s.Key]))
		}

		search := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6,
			Height: core.Pt(28), Padding: core.Symmetric(0, 8), CornerRadius: 7, Background: colors.Field(),
			BorderWidth: 1, BorderColor: colors.FieldBorder(), FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
			ui.Icon(lucide.Search, 12, colors.Faint),
			core.Input{Value: a.impQuery.Get, OnChange: a.impQuery.Set, Placeholder: T("搜索标题或目录"),
				Label: T("搜索可导入会话"), TestID: "import-search",
				Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 12, LineHeight: 18, Color: colors.Text()},
				StyleFunc: func() core.Style {
					return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
				}},
		}}

		var body []core.Node
		if len(rows) == 0 {
			body = append(body, a.importEmpty(rows))
		} else {
			const limit = 400
			shown := rows
			if len(shown) > limit {
				shown = shown[:limit]
			}
			list := make([]core.Node, 0, len(shown))
			for _, row := range shown {
				list = append(list, a.importRowView(row))
			}
			if hidden := len(rows) - len(shown); hidden > 0 {
				list = append(list, core.Text{Content: fmt.Sprintf(T("还有 %d 个未列出，用搜索或来源筛选"), hidden),
					Style: core.Style{FontSize: 10.5, Padding: core.All(6)}, StyleFunc: ui.Colored(colors.Faint)})
			}
			body = append(body, core.Scroll{Style: core.Style{MaxHeight: core.Pt(360)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: list}}})
		}

		head := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			search,
			ui.Button{Text: T("全选"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "import-select-all",
				OnPress: func() { a.selectImportRows() }},
		}}

		pendingCount := 0
		for _, n := range pending {
			pendingCount += n
		}
		desc := T("从 Claude Code、Codex、Cursor 等工具的历史里挑出会话，转换后复制到本应用自己的会话目录：原文件不动，导入的会话按原目录归位。")
		if !a.impScanning.Get() && pendingCount == 0 && len(a.impRows.Get()) > 0 {
			desc = T("都导入了。有更新的会话会重新导入，覆盖之前那一份。")
		}

		return ui.Dialog{
			Open:         a.impOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.impOpen.Set(open) },
			Title:        T("导入会话"),
			Description:  desc,
			TestID:       "import-dialog",
			Style:        core.Style{Width: core.Pt(720), MaxHeight: core.Pt(620)},
			Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Padding: core.Edges{Top: 2, Bottom: 2}}, Children: chips},
				head,
				core.View{Style: core.Style{Gap: 2}, Children: body},
			},
			Footer: a.importFooter(rows),
		}
	})
}
