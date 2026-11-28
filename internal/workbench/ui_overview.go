//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

// The drawer's overview: the active session at a glance. It reports what
// the session is doing, what its agent changed, who it is related to and
// what it spent; every action behind those facts lives in the composer, the
// context menu or the drawer's other tabs, so no control here repeats one.
// A path is the exception: a folder or a session file is useful the moment
// it is read, so each one carries its own copy, reveal and editor actions.

import (
	"fmt"
	"path/filepath"
	"strconv"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

const (
	// overviewChangeLimit is how many changed files the overview lists
	// before it says how many more there are.
	overviewChangeLimit = 6
	// overviewTodoLimit is the same bound for an expanded task list.
	overviewTodoLimit = 24
	// overviewTodosKey is where the session keeps whether the list is open
	// in the overview; it is a row's open state like any other.
	overviewTodosKey = "overview:todos"
	// overviewLabelWidth is the column the session's rows keep for their
	// names, wide enough for 思考 and 会话文件 at the drawer's width.
	overviewLabelWidth = 66
	// overviewRowHeight is one of the session's rows, tall enough for a
	// two-line path beside its name.
	overviewRowHeight = 26
)

// drawerOverview is the drawer's first tab.
func (a *app) drawerOverview() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		s := a.active()
		if s == nil {
			return core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(apptext.T("没有打开的会话"), 12.5, ui.Regular, ui.ColorsOf(cx).Muted),
			}}
		}
		return a.scrollStashFor("drawerOverview:1").Bind(cx, core.Scroll{TestID: "overview-scroll", Style: ui.FillRest, Children: []core.Node{
			// Keep the overlay scrollbar in a stable gutter beside every row.
			core.View{TestID: "overview-content", Style: core.Style{Padding: core.Edges{Top: 4, Bottom: 24, Right: viewkit.PanelInset, Left: 2}}, Children: []core.Node{
				a.overviewHead(cx, s),
				a.overviewTodos(s),
				a.overviewChanges(s),
				a.delegationOverview(s),
				a.overviewResources(s),
				a.overviewSession(s),
				a.overviewRelations(s),
			}},
		}})
	})
}

// overviewSection sets a block off from the one above it with a hairline and
// the room a block needs to read as its own.
func overviewSection(colors ui.Colors, head core.Node, rows ...core.Node) core.Node {
	return core.View{Style: core.Style{Gap: 12, Padding: core.Edges{Top: 16, Bottom: 16}, Borders: core.Edges{Top: 1},
		BorderColors: core.EdgeColors{Top: colors.Line()}}, Children: append([]core.Node{head}, rows...)}
}

// overviewLabel is a block's title: a small caps label, with the nodes that
// follow it pushed to the row's end.
func overviewLabel(colors ui.Colors, title string, trailing ...core.Node) core.Node {
	children := []core.Node{core.Text{Content: title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
		Style: core.Style{FontSize: 13, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)}}
	if len(trailing) > 0 {
		children = append(children, core.View{Style: core.Style{FlexGrow: 1}},
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, FlexShrink: 0}, Children: trailing})
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(20)},
		Children: children}
}

// overviewAction is a quiet text control for a title row: no face until the
// pointer is on it, so the block still reads as a label.
func overviewAction(colors ui.Colors, label, testID string, onPress func()) core.Node {
	return core.View{OnPress: func(core.PressEvent) { onPress() }, Role: core.RoleButton, Label: label, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, MinHeight: core.Pt(28), Padding: core.Symmetric(4, 8),
				CornerRadius: 6, Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()}, FocusVisible: &core.Style{Background: colors.Hover(), BorderWidth: 1, BorderColor: colors.Text()}}
		}, Children: []core.Node{ui.Text(label, 12, ui.Medium, colors.Muted)}}
}

// overviewMeter is a thin bar of fill, from 0 to 1, in tint.
func overviewMeter(colors ui.Colors, fill func() float64, tint func() core.Color) core.Node {
	return core.View{Style: core.Style{Height: core.Pt(5), CornerRadius: 2.5, Background: ui.Alpha(colors.Text(), 0.1),
		Overflow: core.Hidden}, Children: []core.Node{core.View{StyleFunc: func() core.Style {
		return core.Style{Width: core.Pct(float32(min(1, max(0, fill())) * 100)), Height: core.Pt(5), CornerRadius: 2.5,
			Background: tint()}
	}}}}
}

// pathMenu is a path's own actions: showing it in the file manager, or
// opening it in the editor. They live behind one faint button so a line of
// the overview stays a line; copying is the button beside it.
func (a *app) pathMenu(colors ui.Colors, key string, full func() string, reveal func(), testID string) core.Node {
	return ui.Menu{
		Open:         func() bool { return a.overviewMore.Get() == key },
		OnOpenChange: func(open bool, _ base.Reason) { a.setOverviewMore(key, open) },
		Placement:    core.PlaceBottom, Align: core.AlignEnd,
		Trigger: ui.Button{Icon: lucide.Ellipsis, Label: apptext.T("路径操作"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			Side: 22, IconSize: 13, Tint: func() core.Color { return colors.Faint() }},
		TestID: testID,
		Children: []core.Node{
			ui.MenuItem{Text: apptext.T("复制路径"), Icon: lucide.Copy, TestID: testID + "-copy",
				OnSelect: func() { a.copyText(full(), "路径") }},
			ui.MenuItem{Text: apptext.T("在文件管理器中显示"), Icon: lucide.FolderOpen, TestID: testID + "-reveal",
				OnSelect: reveal},
			a.editorOpenItem(full(), "在编辑器中打开", testID+"-edit"),
		},
	}
}

// setOverviewMore opens or closes one path's menu.
func (a *app) setOverviewMore(key string, open bool) {
	if open {
		a.overviewMore.Set(key)
		return
	}
	if a.overviewMore.GetUntracked() == key {
		a.overviewMore.Set("")
	}
}

// overviewPathLine is a path with its actions: pressing it shows the path in
// the file manager, the button beside it copies, and the menu opens it in the
// editor. What is drawn is shortened; what is copied and opened is not.
func (a *app) overviewPathLine(colors ui.Colors, key string, lead func() *core.SVG, shown func() string, full func() string, reveal func(), testID string) core.Node {
	body := core.Text{ContentFunc: shown, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
		Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 11},
		StyleFunc: ui.Colored(colors.Faint)}
	press := core.View{OnPress: func(core.PressEvent) { reveal() }, Role: core.RoleButton,
		Label: apptext.T("在文件管理器中显示"), TestID: testID + "-reveal-row",
		StyleFunc: func() core.Style {
			return core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), CornerRadius: 4,
				Padding: core.Symmetric(0, 3), Margin: core.Edges{Left: -3}, Hover: &core.Style{Background: colors.Hover()}}
		}, Children: []core.Node{body}}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, MinHeight: core.Pt(24)},
		Children: []core.Node{
			ui.Icon(lead, 12, colors.Faint),
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{hintOf(full, press)}},
			hintOf(func() string { return apptext.T("复制路径") }, core.View{
				OnPress: func(core.PressEvent) { a.copyText(full(), "路径") }, Role: core.RoleButton,
				Label: apptext.T("复制路径"), TestID: testID + "-copy",
				StyleFunc: func() core.Style {
					return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, FlexShrink: 0,
						AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
						Hover: &core.Style{Background: colors.Hover()}}
				}, Children: []core.Node{ui.Icon(lucide.Copy, 12, colors.Faint)}}),
			a.pathMenu(colors, key, full, reveal, testID+"-menu"),
		}}
}

// overviewHead is the session's identity: the state it is in, what it is
// called, and the folder it works in.
func (a *app) overviewHead(cx *core.Scope, s *session) core.Node {
	colors := ui.ColorsOf(cx)
	state := []core.Node{
		core.View{Style: core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, FlexShrink: 0},
			StyleFunc: ui.Filled(func() core.Color { return statusDot(colors, s) })},
		ui.Textf(func() string { return sessionStateText(s) }, 11.5, ui.Medium, func() core.Color { return statusDot(colors, s) }),
	}
	if !s.updated.Get().IsZero() {
		state = append(state,
			ui.Text("·", 11, ui.Regular, colors.Faint),
			ui.Textf(func() string { return viewkit.WhenText(s.updated.Get(), cx.Now()) }, 11, ui.Regular, colors.Faint))
	}
	return core.View{Style: core.Style{Gap: 8, Padding: core.Edges{Top: 4, Bottom: 4}}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: state},
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 4}, Children: []core.Node{
			core.Text{ContentFunc: func() string { return s.title.Get() }, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
				Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 17, FontWeight: ui.Semibold, LineHeight: 24},
				StyleFunc: ui.Colored(colors.Text)},
			hintOf(func() string { return apptext.T("重命名") }, ui.IconButton{Icon: lucide.Pencil, Label: apptext.T("重命名"),
				Size: 24, IconSize: 12.5, Tint: colors.Faint, TestID: "overview-rename", OnPress: func() { a.askRename(s) }}),
		}},
		a.overviewPathLine(colors, "ws", lucide.Folder, func() string { return shortPath(s.WS, 44) }, func() string { return s.WS },
			func() { a.revealProject(a.workspaceFor(s.Target, s.WS)) }, "overview-ws"),
	}}
}

// sessionStateText names what the session is doing.
func sessionStateText(s *session) string {
	switch s.status.Get() {
	case statusStarting:
		return apptext.T("启动中")
	case statusRunning:
		return apptext.T("运行中")
	case statusWaiting:
		return apptext.T("等待中")
	case statusFailed:
		return apptext.T("失败")
	}
	return apptext.T("就绪")
}

// overviewTodos is the agent's task list: how far it got, what it is on now,
// and the whole list once the user asks for it. The strip above the composer
// only shows while it is open, so this is where the list can be read late.
func (a *app) overviewTodos(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = s.uiSeq.Get()
		colors := ui.ColorsOf(cx)
		items := a.sessionTodos(s)
		if len(items) == 0 {
			return nil
		}
		done, total := todoCounts(items)
		open := s.toolOpen(overviewTodosKey, false)
		action := apptext.T("查看全部")
		if open {
			action = apptext.T("收起")
		}
		head := overviewLabel(colors, apptext.T("待办"),
			ui.Tabular(core.Text{Content: fmt.Sprintf("%d/%d", done, total),
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)}),
			overviewAction(colors, action, "overview-todos-all", func() { s.toggleOpen(overviewTodosKey) }))
		rows := []core.Node{overviewMeter(colors, func() float64 {
			if total <= 0 {
				return 0
			}
			return float64(done) / float64(total)
		}, colors.Accent)}
		if open {
			shown := items
			if len(shown) > overviewTodoLimit {
				shown = shown[:overviewTodoLimit]
			}
			var list []core.Node
			for _, it := range shown {
				list = append(list, overviewTodoRow(colors, it))
			}
			rows = append(rows, core.View{Style: core.Style{Direction: core.Column, Gap: 2}, Children: list})
			if more := len(items) - len(shown); more > 0 {
				rows = append(rows, ui.Text(fmt.Sprintf(apptext.T("另有 %d 项"), more), 11, ui.Regular, colors.Faint))
			}
			return overviewSection(colors, head, rows...)
		}
		if current := currentTodoText(items); current != "" {
			rows = append(rows, overviewTodoRow(colors, todoItem{Text: current, Status: "in_progress"}))
		}
		return overviewSection(colors, head, rows...)
	})
}

// overviewTodoRow is one task line, drawn as the strip above the composer
// draws it.
func overviewTodoRow(colors ui.Colors, it todoItem) core.Node {
	icon, tint, weight := lucide.Circle, colors.Faint, ui.Regular
	switch it.Status {
	case "completed":
		icon, tint = lucide.CircleCheck, colors.Up
	case "in_progress":
		icon, tint, weight = lucide.Loader, colors.Accent, ui.Medium
	case "cancelled":
		icon, tint = lucide.CircleX, colors.Faint
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 8, MinHeight: core.Pt(22),
		Padding: core.Edges{Right: 4}}, Children: []core.Node{
		core.View{Style: core.Style{Padding: core.Edges{Top: 3}}, Children: []core.Node{ui.Icon(icon, 12, tint)}},
		core.Text{Content: it.Text, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, LineHeight: 17},
			StyleFunc: func() core.Style {
				ink := colors.Text()
				if it.Status == "completed" || it.Status == "cancelled" {
					ink = colors.Faint()
				}
				return core.Style{Color: ink, FontWeight: weight}
			}},
	}}
}

// sessionChanges folds every file the turns edited or wrote into one list,
// the newest turn first.
func sessionChanges(turns []turn) []fileChange {
	var out []fileChange
	at := map[string]int{}
	for i := len(turns) - 1; i >= 0; i-- {
		for _, c := range turnChanges(turns[i]) {
			if ix, ok := at[c.Path]; ok {
				out[ix].Added += c.Added
				out[ix].Removed += c.Removed
				out[ix].Count += c.Count
				continue
			}
			at[c.Path] = len(out)
			out = append(out, c)
		}
	}
	return out
}

// overviewChanges is what the conversation touched: the files its tools
// edited or wrote, newest first, each opening the patch it left behind.
func (a *app) overviewChanges(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		files := sessionChanges(s.turns.Get())
		if len(files) == 0 {
			return nil
		}
		added, removed := 0, 0
		for _, f := range files {
			added += f.Added
			removed += f.Removed
		}
		var trailing []core.Node
		if added > 0 || removed > 0 {
			trailing = append(trailing,
				ui.Tabular(core.Text{Content: fmt.Sprintf("+%d", added),
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11}, StyleFunc: ui.Colored(colors.Up)}),
				ui.Tabular(core.Text{Content: fmt.Sprintf("−%d", removed),
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11}, StyleFunc: ui.Colored(colors.Danger)}))
		}
		shown := files
		if len(shown) > overviewChangeLimit {
			shown = shown[:overviewChangeLimit]
		}
		var rows []core.Node
		for i, c := range shown {
			change := c
			row := core.View{
				OnPress: func(core.PressEvent) { a.openChangedFile(s, change.Path) },
				Role:    core.RoleButton, Label: apptext.T("打开 ") + change.Path, TestID: "overview-change-" + strconv.Itoa(i),
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(24),
						Padding: core.Symmetric(0, 5), Margin: core.Edges{Left: -5}, CornerRadius: 5, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					hintOf(func() string { return change.Path }, core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2, Padding: core.Symmetric(6, 0)}, Children: []core.Node{
						core.Text{Content: filepath.Base(change.Path), MaxLines: 1, EllipsizeMode: core.EllipsizeTail, Style: core.Style{FontSize: 13}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: filepath.Dir(change.Path), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
					}}),
				}}
			if change.Added > 0 || change.Removed > 0 {
				row.Children = append(row.Children,
					ui.Tabular(core.Text{Content: fmt.Sprintf("+%d", change.Added),
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11}, StyleFunc: ui.Colored(colors.Up)}),
					ui.Tabular(core.Text{Content: fmt.Sprintf("−%d", change.Removed),
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11}, StyleFunc: ui.Colored(colors.Danger)}))
			}
			rows = append(rows, row)
		}
		if more := len(files) - len(shown); more > 0 {
			rows = append(rows, ui.Text(fmt.Sprintf(apptext.T("另有 %d 项"), more), 11, ui.Regular, colors.Faint))
		}
		trailing = append(trailing, overviewAction(colors, apptext.T("查看全部"), "overview-changes-all", func() {
			a.files.scope.Set("session")
			a.filesQuery.Set("")
			a.setDrawerTab("files")
		}))
		return overviewSection(colors, overviewLabel(colors, apptext.T("本次改动"), trailing...),
			ui.Text(fmt.Sprintf(apptext.T("修改 %d 个文件"), len(files)), 12, ui.Regular, colors.Muted),
			core.View{Style: core.Style{Direction: core.Column, Gap: 2}, Children: rows})
	})
}

// overviewRelations is how the session hangs together with others: the fork
// it came from, the session it was linked to, and the ones reporting to it.
func (a *app) overviewRelations(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var rows []core.Node
		if parentID := a.cfg.ForkParents[s.ID]; parentID != "" {
			title := a.cfg.Titles[parentID]
			if p := a.byID[parentID]; p != nil {
				title = p.title.Get()
			}
			if title == "" {
				title = apptext.T("原会话")
			}
			children := []core.Node{
				ui.Icon(lucide.GitBranch, 12, colors.Faint),
				core.Text{Content: fmt.Sprintf(apptext.T("分叉自 %s"), title), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)},
			}
			if a.byID[parentID] != nil {
				children = append(children, ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					TestID: "fork-parent", OnPress: func() {
						if p := a.byID[parentID]; p != nil {
							a.selectSession(p)
						}
					}})
			}
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(24)},
				Children: children})
		}
		rows = append(rows, a.sessionRelationRows(cx, s)...)
		if len(rows) == 0 {
			return nil
		}
		return overviewSection(colors, overviewLabel(colors, apptext.T("关联会话")),
			core.View{Style: core.Style{Direction: core.Column, Gap: 3}, Children: rows})
	})
}

// overviewSession is what the session is: its model and thinking level, the
// id and file behind it, and the machine it answers from.
func (a *app) overviewSession(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = s.uiSeq.Get()
		colors := ui.ColorsOf(cx)
		open := s.toolOpen("overview:session", false)
		label := apptext.T("展开")
		if open {
			label = apptext.T("收起")
		}
		head := overviewLabel(colors, apptext.T("这个会话"), overviewAction(colors, label, "overview-session-toggle", func() { s.toggleOpen("overview:session") }))
		if !open {
			return overviewSection(colors, head)
		}
		name := func(label string) core.Node {
			return core.Text{Content: label, Style: core.Style{FontSize: 12.5, Width: core.Pt(overviewLabelWidth), FlexShrink: 0},
				StyleFunc: ui.Colored(colors.Faint)}
		}
		value := func(text func() string, mono bool) core.Node {
			st := core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5}
			if mono {
				st.FontSize, st.FontFamily = 11.5, viewkit.MonoFont()
			}
			return core.Text{ContentFunc: text, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle, Style: st,
				StyleFunc: ui.Colored(colors.Text)}
		}
		icon := func(glyph func() *core.SVG, label, testID string, onPress func()) core.Node {
			return core.View{OnPress: func(core.PressEvent) { onPress() }, Role: core.RoleButton, Label: label, TestID: testID,
				StyleFunc: func() core.Style {
					return core.Style{Width: core.Pt(24), Height: core.Pt(24), CornerRadius: 5, AlignItems: core.AlignCenter,
						JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Hover()}}
				}, Children: []core.Node{ui.Icon(glyph, 13, colors.Faint)}}
		}
		row := func(label string, children ...core.Node) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(overviewRowHeight)},
				Children: append([]core.Node{name(label)}, children...)}
		}
		rows := []core.Node{
			row(apptext.T("模型"), value(func() string {
				m := s.model.Get()
				if m.ID == "" {
					return apptext.T("未选择")
				}
				return m.label()
			}, false), core.Dynamic(func(*core.Scope) core.Node {
				if a.isFavModel(s.model.Get()) {
					return icon(lucide.Star, apptext.T("收藏模型"), "overview-fav-model", func() { a.toggleFavModel(s.model.Get()) })
				}
				return icon(lucide.StarOff, apptext.T("收藏模型"), "overview-fav-model", func() { a.toggleFavModel(s.model.Get()) })
			})),
			row(apptext.T("思考"), value(func() string {
				if t := s.thinking.Get(); t != "" {
					return levelLabel(t)
				}
				return apptext.T("默认")
			}, false)),
			row(apptext.T("会话 ID"), value(func() string { return s.ID }, true),
				icon(lucide.Copy, apptext.T("复制会话 ID"), "overview-copy-id", func() { a.copyText(s.ID, "会话 ID") })),
			core.Show{When: func() bool { return s.File != "" }, Then: func(*core.Scope) core.Node {
				return row(apptext.T("会话文件"), core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)},
					Children: []core.Node{a.overviewPathLine(colors, "file", lucide.FileText, func() string { return shortPath(s.File, 40) },
						func() string { return s.File },
						func() {
							a.revealFilePath(s.Target, s.File)
						}, "overview-file")}})
			}},
			core.Show{When: func() bool { return s.Target.remote() || s.External }, Then: func(*core.Scope) core.Node {
				label := apptext.T("本机")
				if s.Target.remote() {
					label = s.Target.label()
				}
				if s.External {
					label = apptext.T("pi 本地会话 · 继续会写入原文件")
				}
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(overviewRowHeight)},
					Children: []core.Node{
						core.View{Style: core.Style{Width: core.Pt(overviewLabelWidth), FlexShrink: 0, Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5},
							Children: []core.Node{ui.Icon(lucide.Info, 12, colors.Faint)}},
						ui.Text(label, 11.5, ui.Regular, colors.Faint),
					}}
			}},
		}
		return overviewSection(colors, head,
			core.View{Style: core.Style{Direction: core.Column, Gap: 8}, Children: rows})
	})
}
