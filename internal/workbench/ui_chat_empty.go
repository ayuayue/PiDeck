//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"fmt"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// historySkeleton stands in for a session's transcript while pi reads
// its file, so an opening history does not look empty.
func (a *app) historySkeleton(s *session) core.Node {
	colors := ui.ColorsOf(a.cx)
	block := func(i int) core.Node {
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 12}, Children: []core.Node{
			ui.SkeletonBlock{Width: core.Pt(24), Height: core.Pt(24), Round: true, Index: i * 4},
			core.View{Style: core.Style{FlexGrow: 1, Gap: 8}, Children: []core.Node{
				ui.SkeletonBlock{Width: core.Pct(42), Height: core.Pt(9), Index: i*4 + 1},
				ui.SkeletonBlock{Width: core.Pct(92), Height: core.Pt(8), Index: i*4 + 2},
				ui.SkeletonBlock{Width: core.Pct(68), Height: core.Pt(8), Index: i*4 + 3},
			}},
		}}
	}
	return core.View{TestID: "history-skeleton", Accessible: true, Label: apptext.T("正在读取历史会话"),
		Style: core.Style{Position: core.Absolute, Top: core.Pt(0), Left: core.Pt(0), Right: core.Pt(0),
			AlignItems: core.AlignCenter, PointerEvents: core.PointerEventsBoxNone},
		StyleFunc: func() core.Style { return core.Style{Bottom: core.Pt(s.conversation.ComposerHeight())} },
		Children: []core.Node{core.View{Style: core.Style{FlexGrow: 1, Width: core.Pct(100), MaxWidth: core.Pct(float32(a.chatWidthPct())), MinHeight: core.Pt(0),
			JustifyContent: core.JustifyCenter, Padding: core.Symmetric(32, 24), Gap: 22}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
				ui.Spinner{Size: 11, Label: apptext.T("正在读取历史会话")},
				ui.Text(apptext.T("正在读取历史会话…"), 10.5, ui.Regular, colors.Faint),
			}},
			block(0), block(1), block(2),
		}}},
	}
}

// emptyChat centers the input while the transcript has no turns. The
// content can grow past the viewport when the draft or a panel is tall.
func (a *app) emptyChat(s *session, composer core.Node, editor *core.Ref, column func() core.Length, height func() core.Points) core.Node {
	colors := ui.ColorsOf(a.cx)
	var scroll core.Ref
	return core.Scroll{Ref: &scroll, TestID: "chat-start", Style: core.Style{Position: core.Absolute, Top: core.Pt(0),
		Left: core.Pt(0), Right: core.Pt(0), Bottom: core.Pt(0)}, Children: []core.Node{
		core.View{Style: core.Style{AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
			Padding: core.Symmetric(24, chatSidePadding)},
			StyleFunc: func() core.Style { return core.Style{MinHeight: core.Pt(height())} },
			OnLayout: func(core.Bounds) {
				if s.draft.GetUntracked() != "" || len(s.images.GetUntracked()) > 0 || len(pastedFiles(s)) > 0 {
					// The welcome content may scroll away as the draft grows;
					// the composer and its Send action stay in view.
					scroll.ScrollToEnd(false)
				}
			},
			Children: []core.Node{
				core.View{TestID: "chat-start-header", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter,
					Width: core.Pct(100), MinWidth: core.Pt(0), Gap: 16, Margin: core.Edges{Bottom: 32}},
					StyleFunc: func() core.Style { return core.Style{MaxWidth: column()} }, Children: []core.Node{
						a.brandMark(40, "empty-chat-logo"),
						core.Text{ContentFunc: func() string {
							if ws := a.workspaceFor(s.Target, s.WS); ws != nil && !ws.Chat {
								return apptext.T("在 %s 里做点什么", ws.label())
							}
							return apptext.T("开始新的会话")
						}, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
							Style:     core.Style{FontSize: 28, FontWeight: ui.Medium, LineHeight: 40, FlexShrink: 1, MinWidth: core.Pt(0)},
							StyleFunc: ui.Colored(colors.Text)},
					}},
				core.Show{When: func() bool {
					ws := a.workspaceFor(s.Target, s.WS)
					return ws != nil && !ws.Chat && s.agentMode.Get() == modeNormal && s.showingAsk() == nil
				}, Then: func(*core.Scope) core.Node { return starterPrompts(s, editor, column) }},
				composer,
			}},
	}}
}

func starterPrompts(s *session, editor *core.Ref, column func() core.Length) core.Node {
	hasDraft := func() bool { return s.draft.Get() != "" }
	button := func(id, title, prompt string) core.Node {
		return ui.Button{Text: title, Variant: ui.ButtonGhost, TestID: "chat-starter-" + id, Disabled: hasDraft,
			Style:     core.Style{Height: core.Pt(32), MaxWidth: core.Pct(100), CornerRadius: 8},
			TextStyle: core.Style{FontSize: 14, LineHeight: 20}, OnPress: func() {
				if s.draft.GetUntracked() == "" {
					s.draft.Set(prompt)
					editor.Focus()
				}
			}}
	}
	return core.View{TestID: "chat-starter-prompts",
		Style: core.Style{Direction: core.Row, Wrap: core.Wrap, JustifyContent: core.JustifyStart, Gap: 4,
			Width: core.Pct(100), Margin: core.Edges{Bottom: 16}},
		StyleFunc: func() core.Style {
			style := core.Style{MaxWidth: column()}
			// Keep the composer in place as the user starts typing.
			if hasDraft() {
				style.Visibility = core.VisibilityHidden
			}
			return style
		}, Children: []core.Node{
			button("overview", apptext.T("看看这个项目"), apptext.T("先看看当前目录里有什么，用一句话概括它是做什么的。")),
			button("tests", apptext.T("跑一遍测试"), apptext.T("找到这个项目的测试命令，跑一遍，把失败项列出来。")),
			button("explain", apptext.T("解释一处代码"), apptext.T("挑这个项目里最关键的一个文件，解释它的结构。")),
			button("fix", apptext.T("修一个小问题"), apptext.T("看看最近的改动，指出最可能出问题的地方并修掉。")),
		}}
}

// welcome is the project launchpad when no session is selected.
func (a *app) welcome() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		height := core.NewSignal(cx, core.Points(0))
		width := core.NewSignal(cx, core.Points(0))
		var projects []*workspace
		var selected *workspace
		for _, ws := range a.workspaces.Get() {
			if ws.Chat {
				continue
			}
			projects = append(projects, ws)
			if projectWireKey(ws) == a.activeWS.Get() {
				selected = ws
			}
		}
		if selected == nil && len(projects) > 0 {
			selected = projects[0]
		}
		sub, primary := apptext.T("先添加一个项目文件夹，再开会话。"), apptext.T("添加工作区")
		start := func() { a.pickNative("workspace") }
		if selected != nil {
			sub, primary = apptext.T("打开一个会话，或者新建一个。"), apptext.T("新建会话")
			start = func() { a.newProjectSession(selected) }
		}
		children := []core.Node{
			core.View{Style: core.Style{Gap: 16}, Children: []core.Node{
				core.View{TestID: "welcome-header", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 16}, Children: []core.Node{
					a.brandMark(40, "welcome-logo"),
					core.Text{Content: "PiDeck", Role: core.RoleHeader, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 28, LineHeight: 40, FontWeight: ui.Medium, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Text)},
				}},
				core.Text{Content: sub, Style: core.Style{FontSize: 14, LineHeight: 22}, StyleFunc: ui.Colored(colors.Muted)},
				core.View{TestID: "welcome-actions", Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 4}, Children: []core.Node{
					ui.Button{Text: primary, Variant: ui.ButtonPrimary, TestID: "welcome-primary", OnPress: start,
						Style: core.Style{Height: core.Pt(viewkit.PanelControlSize), MaxWidth: core.Pct(100), CornerRadius: 8}, TextStyle: core.Style{FontSize: 14, LineHeight: viewkit.PanelLineHeight}},
					ui.Button{Text: apptext.T("直接对话"), Variant: ui.ButtonGhost, TestID: "welcome-chat", OnPress: func() { a.openChat() },
						Style: core.Style{Height: core.Pt(viewkit.PanelControlSize), MaxWidth: core.Pct(100), CornerRadius: 8}, TextStyle: core.Style{FontSize: 14, LineHeight: viewkit.PanelLineHeight}},
					ui.Button{Text: apptext.T("导入会话"), Variant: ui.ButtonGhost, TestID: "welcome-secondary", OnPress: func() { a.openImportDialog() },
						Style: core.Style{Height: core.Pt(viewkit.PanelControlSize), MaxWidth: core.Pct(100), CornerRadius: 8}, TextStyle: core.Style{FontSize: 14, LineHeight: viewkit.PanelLineHeight}},
				}},
			}},
		}
		if len(projects) > 0 {
			var rows []core.Node
			for _, ws := range projects {
				rows = append(rows, a.welcomeProject(ws))
			}
			children = append(children, core.View{TestID: "welcome-projects", Style: core.Style{Gap: 8}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
					core.Text{Content: apptext.T("项目"), Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight, FontWeight: ui.Medium, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Muted)},
					ui.Button{Text: apptext.T("添加工作区"), Icon: lucide.FolderPlus, Variant: ui.ButtonGhost,
						TestID: "welcome-add-project", Style: core.Style{Height: core.Pt(viewkit.PanelControlSize), CornerRadius: 8},
						TextStyle: core.Style{FontSize: 14, LineHeight: viewkit.PanelLineHeight}, OnPress: func() { a.pickNative("workspace") }},
				}},
				core.View{Style: core.Style{Gap: 4}, Children: rows},
			}})
		}
		return core.Scroll{TestID: "welcome", OnLayout: func(b core.Bounds) {
			height.Set(b.Size.Height)
			width.Set(b.Size.Width)
		},
			Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0)},
			StyleFunc: func() core.Style { return core.Style{Background: ui.Mix(colors.Surface(), colors.Inset(), 0.45)} }, Children: []core.Node{
				core.View{Style: core.Style{AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Padding: core.Symmetric(24, chatSidePadding)},
					StyleFunc: func() core.Style { return core.Style{MinHeight: core.Pt(height.Get())} }, Children: []core.Node{
						core.View{TestID: "welcome-column", Style: core.Style{Width: core.Pct(100), MinWidth: core.Pt(0), Gap: 32},
							StyleFunc: func() core.Style { return core.Style{MaxWidth: a.chatColumnWidth(width.Get())} }, Children: children},
					}},
			}}
	})
}

func (a *app) welcomeProject(ws *workspace) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return base.Button{TestID: "welcome-project-" + ws.key(), Label: apptext.T("新建会话") + ": " + ws.label(),
			OnPress: func(core.PressEvent) { a.newProjectSession(ws) },
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12, MinHeight: core.Pt(56),
				Padding: core.Symmetric(8, 12), CornerRadius: 8},
			StyleFunc: func() core.Style {
				return core.Style{Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}, FocusVisible: ui.FocusRing(cx, 2)}
			}, Children: []core.Node{
				ui.Icon(lucide.Folder, viewkit.PanelIconSize, colors.Muted),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
					core.Text{Content: ws.label(), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 14, LineHeight: viewkit.PanelLineHeight, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: ws.Path, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)},
				}},
				ui.Icon(lucide.ArrowUpRight, viewkit.PanelDetailIconSize, colors.Muted),
			}}
	})
}

// clockTime is when a prompt went out or an answer came back: the date and
// the time, so a session read days later still reads right.
func clockTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("01-02 15:04")
}

// duration renders an elapsed time for a turn.
func duration(d time.Duration) string {
	if d < time.Second {
		return "0s"
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}
