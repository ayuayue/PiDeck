package main

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
)

// view is the whole window.
func (a *app) view() core.Node {
	return core.View{Style: ui.FillRest, Children: []core.Node{
		core.Dynamic(func(*core.Scope) core.Node {
			_ = a.langRev.Get()
			return a.shell()
		}),
		a.paletteDialog(),
		a.pickerDialog(),
		a.targetDialog(),
		a.settingsDialog(),
		a.renameDialog(),
		a.fileOpDialog(),
		a.exportDialog(),
		a.imageDialog(),
		a.confirmDialog(),
		a.askDialog(),
		a.remoteQRDialog(),
		a.gitDiffDialog(),
		a.gitNewBranchDialog(),
		a.providerDialog(),
		a.promptDialog(),
		a.promptImportDialog(),
		a.parallelAskDialog(),
		a.shortcutsDialog(),
		a.searchDialog(),
		a.acpDialog(),
		a.agentDialog(),
		a.projectGroupDialog(),
		ui.Toasts{Toaster: a.toaster, Placement: ui.ToastBottomEnd, Inset: 104, CloseLabel: "关闭", TestID: "toasts"},
	}}
}

// shell is the sidebar beside the chat, with the optional drawer.
func (a *app) shell() core.Node {
	return ui.SidebarShell{
		TestID:         "shell",
		Open:           a.sidebar.Get,
		OnOpenChange:   func(open bool) { a.sidebar.Set(open); a.remember() },
		ToggleLabel:    "侧栏",
		Width:          nil,
		DefaultWidth:   292,
		MinWidth:       240,
		MaxWidth:       400,
		ResizeLabel:    "调整侧栏宽度",
		SidebarActions: []core.Node{a.railActions()},
		Sidebar:        []core.Node{a.rail()},
		SidebarFooter:  []core.Node{a.railFooter()},
		Header:         []core.Node{a.tabBar()},
		Actions: []core.Node{
			ui.IconButton{Icon: lucide.SquareTerminal, Label: "终端", Size: 28, IconSize: 14, TestID: "terminal-toggle",
				Selected: a.term.open.Get, OnPress: a.toggleTerminal},
			ui.IconButton{Icon: lucide.GitBranch, Label: "Git", Size: 28, IconSize: 14, TestID: "git-toggle",
				Selected: func() bool { return a.drawer.Get() && a.drawerTab.Get() == "git" }, OnPress: a.openGit},
		},
		Content:   []core.Node{a.workArea()},
		Right:     []core.Node{a.drawerPanel()},
		RightOpen: a.drawer.Get,
		OnRightOpenChange: func(open bool) {
			a.drawer.Set(open)
			if open && a.drawerTab.GetUntracked() == "git" {
				a.gitAttach()
			}
			a.remember()
		},
		RightToggleLabel:  "会话面板",
		RightResizeLabel:  "调整面板宽度",
		RightDefaultWidth: 316,
		RightMinWidth:     260,
		RightMaxWidth:     460,
	}
}

// workArea is the chat, with the terminal panel under it when it shows.
func (a *app) workArea() core.Node {
	return base.ResizablePanelGroup{
		Axis:                 base.Vertical,
		TestID:               "work-area",
		HandleLabel:          "调整终端高度",
		Style:                core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0)},
		HandleStyleFunc:      ui.HandleLine(a.cx),
		HandleThumbStyle:     ui.HandleThumb(a.cx),
		HandleThumbStyleFunc: ui.HandleThumbColor(a.cx),
		Panels: []base.ResizablePanel{
			{MinSize: 220, Children: []core.Node{a.mainPane()}},
			{Visible: a.term.open.Get, Size: func() core.Points { return core.Points(a.term.height.Get()) },
				MinSize: 110, MaxSize: 640, OnResize: a.terminalResized, TestID: "terminal-panel",
				Children: []core.Node{a.terminalPanel()}},
		},
	}
}

// mainPane is the editor when a file is open, the chat otherwise.
func (a *app) mainPane() core.Node {
	return core.Show{
		When: func() bool { return a.editor.open.Get() },
		Then: func(*core.Scope) core.Node { return a.editorPane() },
		Else: func(*core.Scope) core.Node { return a.chatPane() },
	}
}

// railActions are the rail header's buttons.
func (a *app) railActions() core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2}, Children: []core.Node{
		ui.IconButton{Icon: lucide.SquarePen, Label: "新建会话", Size: 30, IconSize: 15, OnPress: func() {
			ws := a.activeWS.Get()
			if ws == "" {
				if list := a.workspaces.Get(); len(list) > 0 {
					ws = list[0].Path
				}
			}
			a.newSession(ws)
		}},
		ui.IconButton{Icon: lucide.FolderPlus, Label: "添加工作区", Size: 30, IconSize: 15, OnPress: func() { a.pickNative("workspace") }},
		ui.IconButton{Icon: lucide.Command, Label: "命令面板", Size: 30, IconSize: 15, TestID: "rail-palette", OnPress: func() { a.palette.Set(true) }},
	}}
}

// rail is the projects and sessions list: what is pinned, the projects,
// and pi's own sessions when browsing them is on.
func (a *app) rail() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.Scroll{Style: ui.FillRest, Children: []core.Node{
		core.View{Style: core.Style{Padding: core.Edges{Top: 10, Right: 10, Bottom: 12, Left: 10}, Gap: 10}, Children: []core.Node{
			a.brand(),
			a.newSessionButton(),
			a.searchField(),
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Edges{Top: 4, Right: 8, Left: 8}},
				Children: []core.Node{
					core.Text{Content: T("项目"), Style: core.Style{FontSize: 10, FontWeight: ui.Semibold, LetterSpacing: 0.6},
						StyleFunc: ui.Colored(colors.Faint)},
					core.View{Style: core.Style{FlexGrow: 1}},
					core.Text{ContentFunc: func() string { return fmt.Sprint(len(a.workspaces.Get())) },
						Style: core.Style{FontFamily: ui.Mono, FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
					core.View{OnPress: func(core.PressEvent) { a.pickNative("workspace") }, Role: core.RoleButton, Label: "添加项目",
						TestID: "add-project",
						StyleFunc: func() core.Style {
							return core.Style{Direction: core.Row, Padding: core.Symmetric(1, 4), CornerRadius: 4,
								Hover: &core.Style{Background: colors.Hover()}}
						}, Children: []core.Node{ui.Icon(lucide.Plus, 11, colors.Muted)}},
					core.View{OnPress: func(core.PressEvent) { a.openTargetDialog(targetWSL) }, Role: core.RoleButton, Label: "添加 WSL 工作区",
						StyleFunc: func() core.Style {
							return core.Style{Direction: core.Row, Padding: core.Symmetric(1, 4), CornerRadius: 4,
								Hover: &core.Style{Background: colors.Hover()}}
						}, Children: []core.Node{ui.Text("WSL", 9.5, ui.Medium, colors.Faint)}},
					core.View{OnPress: func(core.PressEvent) { a.openTargetDialog(targetSSH) }, Role: core.RoleButton, Label: "添加 SSH 工作区",
						StyleFunc: func() core.Style {
							return core.Style{Direction: core.Row, Padding: core.Symmetric(1, 4), CornerRadius: 4,
								Hover: &core.Style{Background: colors.Hover()}}
						}, Children: []core.Node{ui.Text("SSH", 9.5, ui.Medium, colors.Faint)}},
				}},
			a.projectList(),
		}},
	}}
}

// groupLabel is a quiet heading inside a project: 置顶, 今天, 更早.
func (a *app) groupLabel(text string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Padding: core.Edges{Top: 6, Right: 8, Bottom: 1, Left: 8}}, Children: []core.Node{
			core.Text{Content: text, Style: core.Style{FontFamily: ui.Mono, FontSize: 9, LetterSpacing: 0.5},
				StyleFunc: ui.Colored(colors.Faint)},
		}}
	})
}

// railHeader is a small section title with a count.
func (a *app) railHeader(title, count string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Edges{Top: 4, Right: 8, Bottom: 2, Left: 8}},
		Children: []core.Node{
			ui.Text(title, 10, ui.Semibold, colors.Faint),
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Text(count, 10, ui.Regular, colors.Faint),
		}}
}

// piSessionRow is one of pi's own sessions, with the folder it ran in.
func (a *app) piSessionRow(s *session) core.Node {
	colors := ui.ColorsOf(a.cx)
	selected := func() bool { return a.activeID.Get() == s.ID }
	return base.ContextMenu{
		Trigger: core.View{
			OnPress: func(core.PressEvent) { a.selectSession(s) },
			Role:    core.RoleButton, LabelFunc: func() string { return s.title.Get() },
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(30), Padding: core.Symmetric(0, 8),
					CornerRadius: 7, Transition: pressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				if selected() {
					st.Background = colors.Pressed()
				}
				return st
			},
			Children: []core.Node{
				ui.Icon(lucide.Clock, 12, colors.Faint),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
					core.Text{ContentFunc: func() string { return s.title.Get() }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 12, LineHeight: 16}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{ContentFunc: func() string { return shorten(filepath.Base(s.WS), 34) }, MaxLines: 1,
						Style: core.Style{FontFamily: ui.Mono, FontSize: 9, LineHeight: 12}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			},
		},
		Children:   a.sessionMenuItems(func() *session { return s }),
		PopupStyle: core.Style{MinWidth: core.Pt(200)},
		PopupStyleFunc: func() core.Style {
			return a.menuCard(a.cx)
		},
	}
}

// brand is the wordmark, as a flat tile and a name.
func (a *app) brand() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, Padding: core.Edges{Top: 2, Right: 4, Left: 4}}, Children: []core.Node{
		core.Image{Source: core.ImageSource{Data: logoPNG}, ResizeMode: core.Contain, Label: "PiDeck",
			Style: core.Style{Width: core.Pt(28), Height: core.Pt(28), CornerRadius: 8}},
		core.View{Style: core.Style{Direction: core.Column, Gap: 1}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				core.Text{Content: "PiDeck", Style: core.Style{FontFamily: ui.Mono, FontSize: 14, FontWeight: ui.Bold, LetterSpacing: 0.4},
					StyleFunc: ui.Colored(colors.Text)},
				core.View{StyleFunc: func() core.Style {
					return core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, BorderWidth: 1, BorderColor: colors.Border()}
				}, Children: []core.Node{core.Text{Content: "lite", Style: core.Style{FontFamily: ui.Mono, FontSize: 9},
					StyleFunc: ui.Colored(colors.Faint)}}},
			}},
			core.Text{Content: T("本机 pi 工作台"), Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
		}},
	}}
}

// newSessionButton is the rail's main action.
func (a *app) newSessionButton() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{
		OnPress: func(core.PressEvent) {
			ws := a.activeWS.Get()
			if ws == "" {
				if list := a.workspaces.Get(); len(list) > 0 {
					ws = list[0].Path
				}
			}
			a.newSession(ws)
		},
		Role: core.RoleButton, Label: "新建会话", TestID: "rail-new-session",
		StyleFunc: func() core.Style {
			p := colors.Now()
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(34), Padding: core.Symmetric(0, 10),
				CornerRadius: ui.RadiusControl, Background: colors.Light(), Color: colors.OnLight(), Transition: pressMotion,
				Hover: &core.Style{Background: p.AccentHover}, Active: &core.Style{Background: p.AccentPressed}}
		},
		Children: []core.Node{
			ui.Icon(lucide.Plus, 14, colors.OnLight),
			core.Text{Content: T("新建会话"), Style: core.Style{FontSize: 13, FontWeight: ui.Semibold, FlexGrow: 1}, StyleFunc: ui.Colored(colors.OnLight)},
			core.Text{Content: modKey() + "N", Style: core.Style{FontFamily: ui.Mono, FontSize: 10, Opacity: core.Alpha(0.55)}, StyleFunc: ui.Colored(colors.OnLight)},
		},
	}
}

// searchField filters the rail.
func (a *app) searchField() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(30), Padding: core.Symmetric(0, 9),
			CornerRadius: ui.RadiusControl, Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}
	}, Children: []core.Node{
		ui.Icon(lucide.Search, 13, colors.Faint),
		core.Input{
			Value: a.filter.Get, OnChange: a.filter.Set, Placeholder: T("搜索会话"), Label: T("搜索会话"), TestID: "rail-search",
			Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 12.5, LineHeight: 18, Color: colors.Text()},
			StyleFunc: func() core.Style {
				return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
			},
		},
	}}
}

// projectList is the workspace tree: pinned first, then the named groups.
func (a *app) projectList() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.projectsRev.Get()
		groups := a.projectGroups()
		showHeaders := len(groups) > 1 || (len(groups) == 1 && groups[0].Name != "未分组")
		var out []core.Node
		for _, g := range groups {
			if showHeaders {
				out = append(out, a.groupLabel(g.Name))
			}
			for _, w := range g.Projects {
				ws := w
				out = append(out, a.workspaceBlock(func() *workspace { return ws }))
			}
		}
		return core.View{Style: core.Style{Gap: 2}, Children: out}
	})
}

// workspaceBlock is one project and, when open, its sessions.
func (a *app) workspaceBlock(w func() *workspace) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
		base.ContextMenu{
			Trigger: core.View{
				OnPress: func(core.PressEvent) {
					a.animateNextLayout()
					w().Expanded.Update(func(v bool) bool { return !v })
				},
				Role: core.RoleButton, LabelFunc: func() string { return w().label() },
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(30), Padding: core.Symmetric(0, 8),
						CornerRadius: ui.RadiusControl, Transition: pressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					ui.IconOf(func() *core.SVG {
						if w().Expanded.Get() {
							return lucide.ChevronDown()
						}
						return lucide.ChevronRight()
					}, 12, colors.Faint),
					ui.IconOf(func() *core.SVG {
						if w().Chat {
							return lucide.MessageCircle()
						}
						if w().Expanded.Get() {
							return lucide.FolderOpen()
						}
						return lucide.Folder()
					}, 14, colors.Muted),
					core.Text{ContentFunc: func() string { return w().label() }, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, FontWeight: ui.Medium},
						StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return w().Target.remote() }, Then: func(*core.Scope) core.Node {
						return core.View{StyleFunc: func() core.Style {
							return core.Style{Padding: core.Symmetric(0, 4), CornerRadius: 3, Background: colors.Inset()}
						}, Children: []core.Node{
							ui.Text(w().Target.shortLabel(), 8.5, ui.Medium, colors.Muted),
						}}
					}},
					a.projectCount(w()),
				}},
			Children:   a.projectMenuItems(w),
			PopupStyle: core.Style{MinWidth: core.Pt(196)},
			PopupStyleFunc: func() core.Style {
				return a.menuCard(a.cx)
			},
		},
		core.Show{When: func() bool { return w().Expanded.Get() || a.filter.Get() != "" }, Then: func(cx *core.Scope) core.Node {
			return core.Dynamic(func(cx *core.Scope) core.Node {
				ws := w()
				// A project reads its own pi history the first time it is
				// opened, not every project's at startup.
				a.scanProject(ws)
				pinned, rest := a.projectSessions(ws)
				filter := strings.ToLower(strings.TrimSpace(a.filter.Get()))
				keep := func(list []*session) []*session {
					if filter == "" {
						return list
					}
					var out []*session
					for _, s := range list {
						if strings.Contains(strings.ToLower(s.title.Get()), filter) {
							out = append(out, s)
						}
					}
					return out
				}
				var children []core.Node
				rows := func(list []*session) []core.Node {
					out := make([]core.Node, 0, len(list))
					for _, s := range list {
						out = append(out, a.sessionRowFn(func() *session { return s }))
					}
					return out
				}
				if p := keep(pinned); len(p) > 0 {
					children = append(children, a.groupLabel(T("置顶")), core.View{Style: core.Style{Gap: 1}, Children: rows(p)})
				}
				rest = keep(rest)
				shown := len(rest)
				if filter == "" {
					shown = min(shown, projectVisibleCount(ws))
				}
				for _, g := range sessionBuckets(rest[:shown], a.cx.Now()) {
					children = append(children, a.groupLabel(g.Label), core.View{Style: core.Style{Gap: 1}, Children: rows(g.Rows)})
				}
				loading := ws.PiLoading.Get()
				if loading {
					children = append(children, a.projectLoadingRows()...)
				} else if len(children) == 0 {
					children = append(children, core.Text{Content: T("还没有会话"), Style: core.Style{FontSize: 11, Padding: core.Edges{Left: 8, Top: 4}},
						StyleFunc: ui.Colored(ui.ColorsOf(cx).Faint)})
				}
				hidden := len(rest) - shown
				if filter == "" && !loading && (hidden > 0 || ws.Visible.Get() > 0) {
					children = append(children, a.projectMoreRow(ws, hidden))
				}
				return core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Left: 11}}, Children: children}
			})
		}},
	}}
}

// projectVisibleCount is how many of a project's sessions the rail shows:
// the first page until the user asks for more.
func projectVisibleCount(ws *workspace) int {
	n := ws.Visible.Get()
	if n <= 0 {
		return projectSessionPage
	}
	return n
}

// projectSessionTotal counts a project's sessions, pi's own included and
// duplicates by id once.
func projectSessionTotal(ws *workspace) int {
	seen := map[string]struct{}{}
	for _, list := range []*core.Signal[[]*session]{ws.Sessions, ws.Pi} {
		for _, s := range list.Get() {
			if s != nil {
				seen[s.ID] = struct{}{}
			}
		}
	}
	return len(seen)
}

// projectCount is a project's session count, pulsing while pi's history is
// still being read.
func (a *app) projectCount(ws *workspace) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		if ws.PiLoading.Get() {
			return core.View{TestID: "project-count-loading", Accessible: true, Label: "正在读取会话数量",
				Style:    core.Style{Width: core.Pt(13), Height: core.Pt(8), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
				Children: []core.Node{ui.SkeletonBlock{Width: core.Pt(13), Height: core.Pt(8)}}}
		}
		return core.View{TestID: "project-count", Children: []core.Node{
			core.Text{Content: fmt.Sprint(projectSessionTotal(ws)), Style: core.Style{FontFamily: ui.Mono, FontSize: 10},
				StyleFunc: ui.Colored(colors.Faint)}}}
	})
}

// projectLoadingRows stand in for a project's history while it is read.
func (a *app) projectLoadingRows() []core.Node {
	rows := make([]core.Node, 0, 3)
	for i := 0; i < 3; i++ {
		rows = append(rows, core.View{TestID: "project-loading-row", Accessible: true, Label: "正在读取历史会话",
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(28), Padding: core.Symmetric(0, 8)},
			Children: []core.Node{
				ui.SkeletonBlock{Width: core.Pt(6), Height: core.Pt(6), Round: true, Index: i * 3},
				core.View{Style: core.Style{FlexGrow: 1, Gap: 4}, Children: []core.Node{
					ui.SkeletonBlock{Width: core.Pct(64), Height: core.Pt(6), Index: i*3 + 1},
					ui.SkeletonBlock{Width: core.Pct(36), Height: core.Pt(5), Index: i*3 + 2},
				}},
			}})
	}
	return rows
}

// projectMoreRow shows the next page of a project's sessions and the way
// back to the first one.
func (a *app) projectMoreRow(ws *workspace, hidden int) core.Node {
	colors := ui.ColorsOf(a.cx)
	action := func(label string, icon func() *core.SVG, testID string, press func()) core.View {
		return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleButton, Label: label, TestID: testID,
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(24),
					Padding: core.Symmetric(0, 6), CornerRadius: 5, Transition: pressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{ui.Icon(icon, 11, colors.Faint), ui.Text(label, 10.5, ui.Medium, colors.Muted)}}
	}
	var children []core.Node
	if hidden > 0 {
		more := action(T("更多"), lucide.ChevronDown, "project-more", func() {
			a.animateNextLayout()
			n := ws.Visible.GetUntracked()
			if n <= 0 {
				n = projectSessionPage
			}
			ws.Visible.Set(n + projectSessionStep)
		})
		more.Children = append(more.Children, ui.Text(fmt.Sprintf("(%d)", hidden), 9, ui.Regular, colors.Faint))
		children = append(children, more)
	}
	if ws.Visible.GetUntracked() > 0 {
		children = append(children, action(T("收起"), lucide.ChevronUp, "project-collapse", func() {
			a.animateNextLayout()
			ws.Visible.Set(0)
		}))
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2, Padding: core.Edges{Left: 4}}, Children: children}
}

// sessionRowOf is one session in the rail, given its value.
func (a *app) sessionRowOf(sess *session, pinned bool) core.Node {
	return a.sessionRowFn(func() *session { return sess })
}

// sessionRowFn is one session in the rail.
func (a *app) sessionRowFn(s func() *session) core.Node {
	colors := ui.ColorsOf(a.cx)
	selected := func() bool { return a.activeID.Get() == s().ID }
	return base.ContextMenu{
		Trigger: core.View{
			OnPress: func(core.PressEvent) { a.selectSession(s()) },
			Role:    core.RoleButton, LabelFunc: func() string { return s().title.Get() }, TestID: "session-row",
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(28), Padding: core.Symmetric(0, 8),
					CornerRadius: 7, Transition: pressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				if selected() {
					st.Background = colors.Pressed()
				}
				return st
			},
			Children: []core.Node{
				core.View{StyleFunc: func() core.Style {
					c := colors.Faint()
					switch s().status.Get() {
					case statusRunning:
						c = thinking
					case statusWaiting:
						c = warning
					case statusFailed:
						c = colors.Danger()
					case statusStarting:
						c = colors.Accent()
					}
					return core.Style{Width: core.Pt(5), Height: core.Pt(5), CornerRadius: 3, Background: c, FlexShrink: 0}
				}},
				core.Text{ContentFunc: func() string { return s().title.Get() }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, LineHeight: 18},
					StyleFunc: func() core.Style {
						w := ui.Regular
						if selected() {
							w = ui.Medium
						}
						return core.Style{Color: colors.Text(), FontWeight: w}
					}},
				core.Show{When: func() bool { return s().External }, Then: func(*core.Scope) core.Node {
					return ui.Icon(lucide.Clock, 10.5, colors.Faint)
				}},
				core.Show{When: func() bool { return a.isPinned(s().ID) }, Then: func(*core.Scope) core.Node {
					return ui.Icon(lucide.Star, 11, colors.Faint)
				}},
				core.Text{ContentFunc: func() string { return whenText(s().updated.Get(), a.cx.Now()) }, MaxLines: 1,
					Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)},
			},
		},
		Children:   a.sessionMenuItems(s),
		PopupStyle: core.Style{MinWidth: core.Pt(200)},
		PopupStyleFunc: func() core.Style {
			return a.menuCard(a.cx)
		},
	}
}

// railFooter is the app's status and settings.
func (a *app) railFooter() core.Node {
	colors := ui.ColorsOf(a.cx)
	piLabel := func() string {
		info := a.env.Get()
		if info.Probing {
			return "检测 pi…"
		}
		if info.PiError != "" || info.PiPath == "" {
			return "未找到 pi"
		}
		v := info.PiVersion
		if v != "" {
			return "pi " + shorten(v, 18)
		}
		return "pi 就绪"
	}
	piColor := func() core.Color {
		info := a.env.Get()
		if info.Probing {
			return colors.Muted()
		}
		if info.PiError != "" || info.PiPath == "" {
			return colors.Danger()
		}
		return colors.Up()
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Width: core.Pct(100)}, Children: []core.Node{
		ui.IconButton{Icon: lucide.Settings, Label: "设置", Size: 28, IconSize: 14.5, OnPress: func() { a.settings.Set(true) }},
		ui.IconButton{IconFunc: func() *core.SVG {
			if a.cx.Dark() {
				return lucide.Sun()
			}
			return lucide.Moon()
		}, Label: "切换外观", Size: 28, IconSize: 14.5, OnPress: a.cycleTheme},
		core.View{Style: core.Style{FlexGrow: 1}},
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Padding: core.Edges{Right: 4}}, Children: []core.Node{
			core.View{StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(5), Height: core.Pt(5), CornerRadius: 3, Background: piColor()}
			}},
			core.Text{Content: piLabel(), Style: core.Style{FontFamily: ui.Mono, FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
		}},
	}}
}

// tabBar is the open sessions, above the chat.
func (a *app) tabBar() core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
		core.Scroll{Horizontal: true, HideIndicator: true, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Padding: core.Symmetric(0, 2)}, Children: []core.Node{
				core.Each(a.tabs.Get, func(id string) string { return id }, func(cx *core.Scope, id func() string, _ func() int) core.Node {
					return a.tab(id)
				}),
				ui.IconButton{Icon: lucide.Plus, Label: "新建会话", Size: 26, IconSize: 13, OnPress: func() {
					a.newSession(a.activeWS.Get())
				}},
			}},
		}},
	}}
}

// tab is one open session.
func (a *app) tab(id func() string) core.Node {
	colors := ui.ColorsOf(a.cx)
	sess := func() *session { return a.byID[id()] }
	active := func() bool { return a.activeID.Get() == id() }
	return core.View{
		OnPress: func(core.PressEvent) {
			if s := sess(); s != nil {
				a.selectSession(s)
			}
		},
		OnContextMenu: func(core.ContextMenuEvent) {},
		Role:          core.RoleButton, LabelFunc: func() string { return sess().title.Get() },
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(28), MaxWidth: core.Pt(220),
				Padding: core.Edges{Left: 9, Right: 5}, CornerRadius: 7, BorderWidth: 1, BorderColor: core.Transparent,
				Transition: pressMotion, Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			if active() {
				st.Background = colors.Surface()
				st.BorderColor = colors.Border()
				st.Hover = &core.Style{Background: colors.Surface()}
			}
			return st
		},
		Children: []core.Node{
			core.View{StyleFunc: func() core.Style {
				c := colors.Faint()
				s := sess()
				if s != nil {
					switch s.status.Get() {
					case statusRunning:
						c = thinking
					case statusWaiting:
						c = warning
					case statusFailed:
						c = colors.Danger()
					}
				}
				return core.Style{Width: core.Pt(5), Height: core.Pt(5), CornerRadius: 3, Background: c, FlexShrink: 0}
			}},
			core.Text{ContentFunc: func() string { return sess().title.Get() }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
			core.View{OnPress: func(core.PressEvent) { a.closeTab(id()) }, Role: core.RoleButton, Label: "关闭标签页",
				StyleFunc: func() core.Style {
					return core.Style{Width: core.Pt(18), Height: core.Pt(18), CornerRadius: 5, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
						Transition: pressMotion, Hover: &core.Style{Background: colors.Pressed()}, Active: &core.Style{Background: colors.Pressed()}}
				}, Children: []core.Node{ui.Icon(lucide.X, 11, colors.Faint)}},
		},
	}
}

// drawerPanel is the right panel: the session's numbers and the project's files.
func (a *app) drawerPanel() core.Node {
	colors := ui.ColorsOf(a.cx)
	tab := func(name, label string) core.Node {
		on := func() bool { return a.drawerTab.Get() == name }
		return core.View{
			OnPress: func(core.PressEvent) {
				if a.drawerTab.Get() != name {
					a.animateNextLayout()
				}
				a.drawerTab.Set(name)
				if name == "git" {
					a.gitAttach()
				}
			},
			Role: core.RoleTab, Label: label, TestID: "drawer-tab-" + name,
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(26), Padding: core.Symmetric(0, 10),
					CornerRadius: 6, Transition: pressMotion, Hover: &core.Style{Background: colors.Hover()},
					Active: &core.Style{Background: colors.Pressed()}}
				if on() {
					st.Background = colors.Surface()
					st.BorderWidth = 1
					st.BorderColor = colors.Border()
				}
				return st
			},
			Children: append([]core.Node{core.Text{Content: label, Style: core.Style{FontSize: 12},
				StyleFunc: func() core.Style {
					w := ui.Regular
					if on() {
						w = ui.Semibold
					}
					return core.Style{Color: colors.Text(), FontWeight: w}
				}}}, func() []core.Node {
				if name != "git" {
					return nil
				}
				return []core.Node{core.Dynamic(func(*core.Scope) core.Node {
					n := len(a.git.state.Get().Files)
					if n == 0 {
						return nil
					}
					return core.View{Style: core.Style{MinWidth: core.Pt(15), Height: core.Pt(15), Padding: core.Symmetric(0, 4),
						CornerRadius: 8, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Background: colors.Inset()},
						Children: []core.Node{ui.Text(fmt.Sprint(n), 8.5, ui.Medium, colors.Faint)}}
				})}
			}()...),
		}
	}
	return core.View{Style: core.Style{Padding: core.All(12), Gap: 10, Width: core.Pct(100)}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
			tab("overview", T("概览")),
			tab("files", T("文件")),
			tab("git", "Git"),
			core.View{Style: core.Style{FlexGrow: 1}},
			core.Show{When: func() bool { return a.drawerTab.Get() == "files" }, Then: func(cx *core.Scope) core.Node {
				return core.View{Style: core.Style{Direction: core.Row, Gap: 2}, Children: []core.Node{
					ui.IconButton{Icon: lucide.RefreshCw, Label: T("刷新文件"), Size: 26, IconSize: 12.5, OnPress: func() { a.files.reload() }},
					ui.IconButton{Icon: lucide.Eye, Label: T("显示隐藏文件"), Size: 26, IconSize: 12.5, OnPress: func() { a.files.setHidden(!a.files.hidden.Get()) }},
				}}
			}},
		}},
		core.Dynamic(func(cx *core.Scope) core.Node {
			switch a.drawerTab.Get() {
			case "files":
				return a.drawerFiles()
			case "git":
				return a.drawerGit()
			default:
				return a.drawerOverview()
			}
		}),
	}}
}

// drawerOverview is the active session's totals and actions.
func (a *app) drawerOverview() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		s := a.active()
		if s == nil {
			return core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(T("没有打开的会话"), 12.5, ui.Regular, ui.ColorsOf(cx).Muted),
			}}
		}
		colors := ui.ColorsOf(cx)
		row := func(label string, value func() string) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(24)}, Children: []core.Node{
				core.Text{Content: label, Style: core.Style{FontSize: 12, Width: core.Pt(74)}, StyleFunc: ui.Colored(colors.Muted)},
				core.Text{ContentFunc: value, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12},
					StyleFunc: ui.Colored(colors.Text)},
			}}
		}
		contextText := func() string {
			st := s.stats.Get()
			if st.ContextWindow > 0 {
				return fmt.Sprintf("%s / %s (%.0f%%)", tokens(st.ContextTokens), tokens(st.ContextWindow), st.ContextPercent)
			}
			u := s.usage.Get()
			m := s.model.Get()
			if u.Total > 0 && m.ContextWindow > 0 {
				return fmt.Sprintf("%s / %s", tokens(u.Total), tokens(m.ContextWindow))
			}
			return "还没有用量"
		}
		fraction := func() float64 {
			st := s.stats.Get()
			if st.ContextWindow > 0 {
				return min(1, float64(st.ContextTokens)/float64(st.ContextWindow))
			}
			u := s.usage.Get()
			m := s.model.Get()
			if m.ContextWindow > 0 && u.Total > 0 {
				return min(1, float64(u.Total)/float64(m.ContextWindow))
			}
			return -1
		}
		bar := func() core.Node {
			return core.View{Style: core.Style{Height: core.Pt(4), CornerRadius: 2, Background: colors.Track(), Overflow: core.Hidden, Margin: core.Edges{Top: 2}}, Children: []core.Node{
				core.View{StyleFunc: func() core.Style {
					f := fraction()
					if f < 0 {
						f = 0
					}
					return core.Style{Width: core.Pct(float32(f * 100)), Height: core.Pt(4), Background: colors.Accent()}
				}},
			}}
		}
		models := func() string {
			m := s.model.Get()
			if m.ID == "" {
				return "未选择"
			}
			return m.label()
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Gap: 14, Padding: core.Edges{Top: 2, Bottom: 20, Right: 2, Left: 2}}, Children: []core.Node{
				core.View{StyleFunc: func() core.Style {
					return core.Style{Gap: 4, Padding: core.All(12), CornerRadius: ui.RadiusControl, Background: colors.Surface(), BorderWidth: 1, BorderColor: colors.Border()}
				}, Children: []core.Node{
					core.Text{ContentFunc: func() string { return s.title.Get() }, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 13, FontWeight: ui.Semibold, LineHeight: 19}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{ContentFunc: func() string { return shortPath(s.WS, 44) }, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: ui.Mono, FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
				}},
				core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(24)}, Children: []core.Node{
						core.Text{Content: "模型", Style: core.Style{FontSize: 12, Width: core.Pt(74)}, StyleFunc: ui.Colored(colors.Muted)},
						core.Text{ContentFunc: models, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
						core.View{OnPress: func(core.PressEvent) { a.toggleFavModel(s.model.Get()) }, Role: core.RoleButton, Label: "收藏模型",
							StyleFunc: func() core.Style {
								return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
									JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Hover()}}
							},
							Children: []core.Node{core.Dynamic(func(*core.Scope) core.Node {
								if a.isFavModel(s.model.Get()) {
									return ui.Icon(lucide.Star, 13, colors.Text)
								}
								return ui.Icon(lucide.StarOff, 13, colors.Faint)
							})}},
					}},
					row(T("思考"), func() string {
						if t := s.thinking.Get(); t != "" {
							return levelLabel(t)
						}
						return "默认"
					}),
					row(T("会话 ID"), func() string { return s.ID }),
					core.Show{When: func() bool { return s.Target.remote() || s.External }, Then: func(cx *core.Scope) core.Node {
						label := "本机"
						if s.Target.remote() {
							label = s.Target.label()
						}
						if s.External {
							label = "pi 本地会话 · 继续会写入原文件"
						}
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
							ui.Icon(lucide.Info, 11, colors.Faint),
							ui.Text(label, 10.5, ui.Regular, colors.Faint),
						}}
					}},
				}},
				core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter}, Children: []core.Node{
						ui.Text(T("上下文"), 12, ui.Regular, colors.Muted),
						core.View{Style: core.Style{FlexGrow: 1}},
						core.Text{ContentFunc: contextText, Style: core.Style{FontFamily: ui.Mono, FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
					}},
					bar(),
				}},
				core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
					row(T("输入"), func() string { return tokens(s.usage.Get().Input) + " tokens" }),
					row(T("输出"), func() string { return tokens(s.usage.Get().Output) + " tokens" }),
					row(T("缓存读"), func() string { return tokens(s.usage.Get().CacheRead) + " tokens" }),
					row(T("费用"), func() string { return credits(s.usage.Get().Cost) }),
					row(T("工具调用"), func() string {
						st := s.stats.Get()
						if st.Known {
							return fmt.Sprint(st.ToolCalls)
						}
						n := 0
						for _, t := range s.turns.Get() {
							n += len(t.Steps)
						}
						return fmt.Sprint(n)
					}),
				}},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: []core.Node{
					ui.Button{Text: T("压缩上下文"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.compact(s) }},
					ui.Button{Text: T("导出…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "export-button",
						OnPress: func() { a.openExport(s) }},
					ui.Button{Text: T("重命名"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.askRename(s) }},
					ui.Button{Text: T("文件"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.drawerTab.Set("files") }},
					ui.Button{Text: "Git", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.openGit() }},
					ui.Button{Text: T("终端"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.toggleTerminal() }},
				}},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap}, Children: []core.Node{
					core.Text{ContentFunc: func() string { return shortPath(s.File, 46) }, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, LineHeight: 14}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			}},
		}}
	})
}

// drawerFiles is the active workspace's tree.
func (a *app) drawerFiles() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		s := a.active()
		root := a.files.root.Get()
		if s != nil && s.WS != "" {
			root = s.WS
		}
		if root == "" {
			return core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(T("先打开一个工作区"), 12.5, ui.Regular, colors.Muted),
			}}
		}
		head := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			ui.Icon(lucide.Folder, 12, colors.Muted),
			core.Text{Content: filepath.Base(root), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FlexGrow: 1, FontSize: 11.5, FontFamily: ui.Mono}, StyleFunc: ui.Colored(colors.Muted)},
		}}
		empty := func() core.Node {
			return core.View{Style: core.Style{Padding: core.Symmetric(10, 4)}, Children: []core.Node{
				ui.Text(T("目录为空"), 11.5, ui.Regular, colors.Faint),
			}}
		}
		marks := a.fileMarks()
		dirs := changedDirs(marks, root)
		markColor := func(mark string) core.Color {
			switch gitMarkColor(mark) {
			case "up":
				return colors.Up()
			case "down":
				return colors.Danger()
			case "warn":
				return colors.Warn()
			}
			return colors.Faint()
		}
		list := core.Each(a.files.nodes.Get, func(n fileNode) string { return n.Path }, func(cx *core.Scope, n func() fileNode, _ func() int) core.Node {
			node := n()
			row := core.View{
				OnPress: func(core.PressEvent) {
					if node.Dir {
						a.animateNextLayout()
						a.files.toggle(node.Path)
						return
					}
					a.openEditorFile(root, node.Path)
				},
				Role: core.RoleButton, Label: node.Name, TestID: "file-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(25),
						Padding: core.Edges{Left: core.Points(4 + node.Depth*13), Right: 6}, CornerRadius: 6,
						Transition: pressMotion, Hover: &core.Style{Background: colors.Hover()},
						Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					core.View{Style: core.Style{Width: core.Pt(12), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter}, Children: []core.Node{
						core.Dynamic(func(*core.Scope) core.Node {
							if !node.Dir {
								return nil
							}
							if node.Expanded {
								return ui.Icon(lucide.ChevronDown, 10, colors.Faint)
							}
							return ui.Icon(lucide.ChevronRight, 10, colors.Faint)
						}),
					}},
					ui.IconOf(func() *core.SVG {
						if node.Dir {
							if node.Expanded {
								return lucide.FolderOpen()
							}
							return lucide.Folder()
						}
						return lucide.FileText()
					}, 12.5, func() core.Color {
						if node.Dir {
							return colors.Muted()
						}
						return colors.Faint()
					}),
					core.Text{Content: node.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return node.Dir && dirs[node.Path] }, Then: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Width: core.Pt(5), Height: core.Pt(5), CornerRadius: 3,
							Background: colors.Warn(), FlexShrink: 0}}
					}},
					core.Show{When: func() bool { _, ok := marks[node.Path]; return !node.Dir && ok }, Then: func(*core.Scope) core.Node {
						mark := marks[node.Path].mark()
						return core.View{TestID: "file-git-mark", Accessible: true, Label: mark,
							Style: core.Style{Width: core.Pt(12), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
							Children: []core.Node{core.Text{Content: mark, Style: core.Style{FontFamily: ui.Mono,
								FontSize: 9.5, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(func() core.Color { return markColor(mark) })}}}
					}},
				},
			}
			return base.ContextMenu{
				Trigger:        row,
				Children:       a.fileMenuItems(root, node),
				PopupStyle:     core.Style{MinWidth: core.Pt(200)},
				PopupStyleFunc: func() core.Style { return a.menuCard(a.cx) },
			}
		})
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Gap: 4, Padding: core.Edges{Top: 2, Bottom: 20, Right: 2, Left: 2}}, Children: []core.Node{
				head,
				core.Text{Content: T("点文件在编辑器里打开，点目录展开；右键可插入 @ 路径。"), Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)},
				core.Show{When: func() bool { return len(a.files.nodes.Get()) == 0 }, Then: func(*core.Scope) core.Node { return empty() }},
				list,
			}},
		}}
	})
}

// whenText is a short age for a list.
func whenText(t time.Time, now time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := now.Sub(t)
	switch {
	case d < time.Minute:
		return "刚刚"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	case d < 7*24*time.Hour:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
	return t.Format("1/2")
}

// levelLabel names a thinking level in Chinese.
func levelLabel(level string) string {
	switch level {
	case "off":
		return T("关")
	case "minimal":
		return T("极简")
	case "low":
		return T("低")
	case "medium":
		return T("中")
	case "high":
		return T("高")
	case "xhigh":
		return T("极高")
	case "max":
		return T("最大")
	}
	return level
}

// --- dialogs ------------------------------------------------------------

// paletteDialog is the command palette.
func (a *app) paletteDialog() core.Node {
	return ui.CommandDialog{
		Open:         a.palette.Get,
		OnOpenChange: func(open bool, _ base.Reason) { a.palette.Set(open) },
		TestID:       "palette",
		Command: ui.Command{
			Items:       a.commandItems,
			Placeholder: T("搜索命令、会话或工作区…"),
			SearchLabel: T("命令"),
			Empty:       T("没有匹配的命令"),
			OnSelect:    a.runCommand,
		},
	}
}

// pickerDialog is the folder and session file browser.
func (a *app) pickerDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		p := a.pick
		importing := p.mode.Get() == "import"
		title := T("添加工作区")
		sub := T("选一个项目文件夹；会话会在它的目录里运行。")
		if importing {
			title = T("导入会话")
			sub = T("选一个 pi、Codex 或 Claude 的 .jsonl 会话文件；会转换并复制到本应用自己的会话目录，不改动原文件。")
		}
		row := func(e pickEntry) core.Node {
			selected := func() bool { return p.selected.Get() == e.Path }
			return core.View{
				OnPress: func(core.PressEvent) {
					if e.Dir {
						p.load(e.Path)
						return
					}
					if importing {
						p.selected.Set(e.Path)
					}
				},
				Role: core.RoleButton, Label: e.Name,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(30),
						Padding: core.Symmetric(0, 10), CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()}}
					if selected() {
						st.Background = colors.Pressed()
					}
					return st
				},
				Children: []core.Node{
					ui.IconOf(func() *core.SVG {
						if e.Dir {
							return lucide.Folder()
						}
						return lucide.FileText()
					}, 14, func() core.Color {
						if e.Dir {
							return colors.Muted()
						}
						return colors.Faint()
					}),
					core.Text{Content: e.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return !e.Dir && importing }, Then: func(*core.Scope) core.Node {
						return core.Text{Content: T("会话"), Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
					}},
				},
			}
		}
		var rows []core.Node
		rows = append(rows, core.Show{When: func() bool { return len(p.visible()) == 0 }, Then: func(*core.Scope) core.Node {
			return core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(T("这个文件夹是空的"), 12, ui.Regular, colors.Faint),
			}}
		}})
		rows = append(rows, core.Each(func() []pickEntry { return p.visible() }, func(e pickEntry) string { return e.Path },
			func(cx *core.Scope, e func() pickEntry, _ func() int) core.Node { return row(e()) }))
		places := p.places(a.workspaces.Get())
		var placeChips []core.Node
		for _, pl := range places {
			entry := pl
			placeChips = append(placeChips, core.View{
				OnPress: func(core.PressEvent) { p.load(entry.Path) },
				Role:    core.RoleButton, Label: entry.Name,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), Padding: core.Symmetric(0, 9),
						CornerRadius: 13, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{ui.Icon(lucide.FolderGit2, 11, colors.Muted), ui.Text(entry.Name, 11.5, ui.Regular, colors.Muted)},
			})
		}
		primary := T("选择这个文件夹")
		if importing {
			primary = T("导入")
		}
		return ui.Dialog{
			Open:         p.open.Get,
			OnOpenChange: func(open bool, _ base.Reason) { p.open.Set(open) },
			Title:        title,
			Description:  sub,
			TestID:       "picker",
			Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: placeChips},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.View{StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0),
							Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7, Background: colors.Field(),
							BorderWidth: 1, BorderColor: colors.FieldBorder()}
					}, Children: []core.Node{
						ui.Icon(lucide.Folder, 13, colors.Faint),
						core.Input{
							Value: p.addr.Get, OnChange: p.addr.Set, Placeholder: T("输入路径后回车"),
							Label: T("文件夹路径"), SubmitBehavior: core.SubmitBehaviorSubmit,
							OnSubmit: func(text string) { p.load(text) },
							Style:    core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 12, Color: colors.Text()},
							StyleFunc: func() core.Style {
								return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
							},
						},
					}},
					ui.IconButton{Icon: lucide.ArrowUp, Label: T("上一级"), Size: 28, IconSize: 14, OnPress: p.up},
					ui.IconButton{Icon: lucide.RefreshCw, Label: T("刷新"), Size: 28, IconSize: 13, OnPress: func() { p.load(p.path.GetUntracked()) }},
					ui.IconButton{Icon: lucide.Eye, Label: T("显示隐藏文件"), Size: 28, IconSize: 13,
						Selected: p.hidden.Get, OnPress: func() { p.hidden.Update(func(v bool) bool { return !v }) }},
				}},
				core.View{Style: core.Style{Height: core.Pt(300), MinHeight: core.Pt(0), BorderWidth: 1, BorderColor: colors.Border(),
					CornerRadius: ui.RadiusControl, Overflow: core.Hidden, Background: colors.Background()}, Children: []core.Node{
					core.Scroll{Style: ui.FillRest, Children: []core.Node{
						core.View{Style: core.Style{Padding: core.All(4), Gap: 1}, Children: rows},
					}},
				}},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(16)}, Children: []core.Node{
					core.Show{When: func() bool { return p.loading.Get() }, Then: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
							ui.Spinner{Size: 11}, ui.Text(T("读取中…"), 11.5, ui.Regular, colors.Faint),
						}}
					}},
					core.Text{ContentFunc: func() string { return p.err.Get() }, MaxLines: 2, Style: core.Style{FlexShrink: 1, FontSize: 11},
						StyleFunc: ui.Colored(colors.Danger)},
				}},
			},
			Footer: []core.Node{
				ui.Button{Text: T("系统选择器"), Variant: ui.ButtonGhost, TestID: "picker-native", OnPress: func() {
					mode := p.mode.GetUntracked()
					p.open.Set(false)
					a.pickNative(mode)
				}},
				ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, OnPress: func() { p.open.Set(false) }},
				ui.Button{Text: primary, Variant: ui.ButtonPrimary, Disabled: func() bool { _, ok := p.chosen(); return !ok },
					TestID: "picker-choose", OnPress: func() {
						if path, ok := p.chosen(); ok {
							a.pickerChosen(path)
						}
					}},
			},
		}
	})
}

// openTargetDialog opens the remote workspace dialog for a kind.
func (a *app) openTargetDialog(kind targetKind) {
	a.addKind.Set(int(kind))
	info := a.env.GetUntracked()
	where := ""
	if kind == targetWSL && len(info.WSL) > 0 {
		where = info.WSL[0].Name
	}
	if kind == targetSSH && len(info.SSH) > 0 {
		where = info.SSH[0].Name
	}
	a.addWhere.Set(where)
	a.addPath.Set("")
	a.addTarget.Set(true)
}

// targetDialog names a folder on WSL or on an SSH host to work in.
func (a *app) targetDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		kind := targetKind(a.addKind.Get())
		env := a.env.Get()
		var options []string
		var label, hint, placeholder string
		if kind == targetSSH {
			for _, h := range env.SSH {
				options = append(options, h.Name)
			}
			label, hint = T("SSH 主机"), T("从 ~/.ssh/config 里读到的 Host；远端需要装好 pi，并已配置免密登录。")
			placeholder = "/home/you/project"
		} else {
			for _, d := range env.WSL {
				options = append(options, d.Name)
			}
			label, hint = T("WSL 发行版"), T("在 Windows 上通过 wsl.exe 运行 pi；会话存在该发行版的 ~/.pideck-lite/sessions。")
			placeholder = "$HOME/project 或 /mnt/c/Users/you/project"
		}
		if len(options) == 0 {
			options = []string{""}
		}
		var chips []core.Node
		for _, o := range options {
			value := o
			selected := func() bool { return a.addWhere.Get() == value }
			chips = append(chips, core.View{
				OnPress: func(core.PressEvent) { a.addWhere.Set(value) },
				Role:    core.RoleRadio, Label: value,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), Padding: core.Symmetric(0, 10),
						CornerRadius: 13, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
					if selected() {
						st.Background = colors.Pressed()
						st.BorderColor = colors.Text()
					}
					return st
				},
				Children: []core.Node{ui.Text(value, 12, ui.Regular, colors.Text)},
			})
		}
		return ui.Dialog{
			Open:         a.addTarget.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.addTarget.Set(open) },
			Title:        T(map[targetKind]string{targetWSL: "在 WSL 里工作", targetSSH: "在 SSH 主机上工作"}[kind]),
			Description:  hint,
			TestID:       "target-dialog",
			Children: []core.Node{
				core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					ui.Text(label, 12.5, ui.Semibold, colors.Text),
					core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: chips},
					core.Show{When: func() bool { return len(options) == 1 && options[0] == "" }, Then: func(*core.Scope) core.Node {
						return core.Text{Content: T("没有读到可用的目标：先在系统里配一个 WSL 发行版或 SSH Host。"),
							Style: core.Style{FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Warn)}
					}},
				}},
				core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					ui.Text(T("目录"), 12.5, ui.Semibold, colors.Text),
					core.Input{
						Value: a.addPath.Get, OnChange: a.addPath.Set, Placeholder: placeholder, Label: T("远端目录"), AutoFocus: true,
						OnSubmit: func(string) { a.addRemoteWorkspace() },
						StyleFunc: func() core.Style {
							return core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 10), CornerRadius: 7, Background: colors.Field(),
								BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), FontSize: 12.5, FontFamily: ui.Mono}
						},
					},
				}},
			},
			Footer: []core.Node{
				ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, OnPress: func() { a.addTarget.Set(false) }},
				ui.Button{Text: T("添加并开会话"), Variant: ui.ButtonPrimary, TestID: "target-add", OnPress: func() { a.addRemoteWorkspace() }},
			},
		}
	})
}

// appearanceButton is one choice of the settings' look.
func (a *app) appearanceButton(label, value string) core.Node {
	colors := ui.ColorsOf(a.cx)
	on := func() bool { return a.theme.Get() == value }
	return core.View{
		OnPress: func(core.PressEvent) { a.setTheme(value) },
		Role:    core.RoleRadio, Label: label,
		StyleFunc: func() core.Style {
			st := core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 12), CornerRadius: 7, Direction: core.Row,
				AlignItems: core.AlignCenter, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
			if on() {
				st.Background = colors.Pressed()
				st.BorderColor = colors.Text()
			}
			return st
		},
		Children: []core.Node{ui.Textf(func() string {
			if on() {
				return "✓ " + label
			}
			return label
		}, 12.5, ui.Regular, colors.Text)},
	}
}

// renameDialog names the session being renamed.
func (a *app) renameDialog() core.Node {
	colors := ui.ColorsOf(a.cx)
	return ui.Dialog{
		Open:         a.renameOpen.Get,
		OnOpenChange: func(open bool, _ base.Reason) { a.renameOpen.Set(open) },
		Title:        T("重命名会话"),
		TestID:       "rename",
		Children: []core.Node{core.Input{
			Value: a.renameText.Get, OnChange: a.renameText.Set, Placeholder: T("会话名称"), Label: T("会话名称"), AutoFocus: true,
			OnSubmit: func(string) { a.rename() },
			StyleFunc: func() core.Style {
				return core.Style{Height: core.Pt(34), Padding: core.Symmetric(0, 10), CornerRadius: 7, Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), FontSize: 13}
			},
		}},
		Footer: []core.Node{
			ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, TestID: "rename-cancel", OnPress: func() { a.renameOpen.Set(false) }},
			ui.Button{Text: T("重命名"), Variant: ui.ButtonPrimary, TestID: "rename-ok", OnPress: func() { a.rename() }},
		},
	}
}

// confirmDialog asks before something permanent.
func (a *app) confirmDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return ui.Dialog{
			Open:         a.confirmOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.confirmOpen.Set(open) },
			TestID:       "confirm",
			Style:        core.Style{Width: core.Pt(380)},
			Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10}, Children: []core.Node{
					core.View{StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(30), Height: core.Pt(30), CornerRadius: 8, FlexShrink: 0,
							Background: ui.Alpha(colors.Danger(), 0.10), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter}
					}, Children: []core.Node{ui.Icon(lucide.TriangleAlert, 15, colors.Danger)}},
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
						core.Text{ContentFunc: func() string { return a.confirmHead.Get() },
							Style: core.Style{FontSize: 14, FontWeight: ui.Semibold, LineHeight: 20}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{ContentFunc: func() string { return a.confirmWhy.Get() + T("后无法撤销") },
							Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)},
					}},
				}},
				core.View{StyleFunc: func() core.Style {
					return core.Style{Padding: core.Symmetric(10, 12), CornerRadius: 8, Background: colors.Inset(),
						BorderWidth: 1, BorderColor: colors.Now().Line}
				}, Children: []core.Node{
					core.Text{ContentFunc: func() string { return a.confirmBody.Get() },
						Style: core.Style{FontSize: 12.5, LineHeight: 19}, StyleFunc: ui.Colored(colors.Text)},
				}},
			},
			Footer: []core.Node{
				ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, TestID: "confirm-cancel", OnPress: func() { a.confirmOpen.Set(false) }},
				ui.Button{Text: a.confirmWhy.Get(), Variant: ui.ButtonPrimary, TestID: "confirm-ok",
					Color:   func() core.Color { return colors.Danger() },
					OnPress: func() { a.confirm() }},
			},
		}
	})
}

// askDialog answers an extension's confirm, select, input or editor.
func (a *app) askDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.askSeq.Get()
		colors := ui.ColorsOf(cx)
		s, ask := a.pendingAsk()
		if ask == nil {
			return nil
		}
		cancel := func() { a.answerAsk(s, map[string]any{"cancelled": true}) }
		title := ask.Title
		if title == "" {
			title = T(map[string]string{"confirm": "确认", "select": "选择一个选项", "input": "输入", "editor": "编辑内容"}[ask.Method])
		}
		switch ask.Method {
		case "confirm":
			body := ask.Message
			if body == "" {
				body = T("pi 扩展请求确认。")
			}
			return ui.Dialog{
				Open: func() bool { return true }, OnOpenChange: func(bool, base.Reason) {}, Title: title, Description: body, TestID: "ask",
				NoCloseOnBackdropPress: true, NoCloseOnEscape: true,
				Footer: []core.Node{
					ui.Button{Text: T("拒绝"), Variant: ui.ButtonSecondary, OnPress: func() {
						a.answerAsk(s, map[string]any{"confirmed": false})
					}},
					ui.Button{Text: T("允许"), Variant: ui.ButtonPrimary, OnPress: func() {
						a.answerAsk(s, map[string]any{"confirmed": true})
					}},
				},
			}
		case "select":
			var buttons []core.Node
			for _, opt := range ask.Options {
				value := opt
				buttons = append(buttons, ui.Button{Text: value, Variant: ui.ButtonSecondary, OnPress: func() {
					a.answerAsk(s, map[string]any{"value": value})
				}})
			}
			buttons = append(buttons, ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, OnPress: cancel})
			return ui.Dialog{Open: func() bool { return true }, OnOpenChange: func(bool, base.Reason) {}, Title: title, Description: ask.Message,
				TestID: "ask", NoCloseOnBackdropPress: true, NoCloseOnEscape: true,
				Children: []core.Node{core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: buttons}}}
		default:
			return ui.Dialog{Open: func() bool { return true }, OnOpenChange: func(bool, base.Reason) {}, Title: title, Description: ask.Message,
				TestID: "ask", NoCloseOnBackdropPress: true, NoCloseOnEscape: true,
				Children: []core.Node{core.Input{
					Value: a.askEdit.Get, OnChange: a.askEdit.Set, Placeholder: ask.Default, Label: title, AutoFocus: true,
					Multiline: ask.Method == "editor",
					StyleFunc: func() core.Style {
						return core.Style{MinHeight: core.Pt(34), Padding: core.Symmetric(8, 10), CornerRadius: 7, Background: colors.Field(),
							BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), FontSize: 13}
					},
				}},
				Footer: []core.Node{
					ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, OnPress: cancel},
					ui.Button{Text: T("确定"), Variant: ui.ButtonPrimary, OnPress: func() {
						a.answerAsk(s, map[string]any{"value": a.askEdit.Get()})
					}},
				}}
		}
	})
}

// modKey names the platform's shortcut modifier for labels.
func modKey() string {
	if runtime.GOOS == "darwin" {
		return "⌘"
	}
	return "Ctrl+"
}
