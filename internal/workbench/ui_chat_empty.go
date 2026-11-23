//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"fmt"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
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
	return core.Scroll{TestID: "chat-start", Style: core.Style{Position: core.Absolute, Top: core.Pt(0),
		Left: core.Pt(0), Right: core.Pt(0), Bottom: core.Pt(0)}, Children: []core.Node{
		core.View{Style: core.Style{AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
			Padding: core.Symmetric(24, chatSidePadding)},
			StyleFunc: func() core.Style { return core.Style{MinHeight: core.Pt(height())} },
			Children: []core.Node{
				core.View{Style: core.Style{AlignItems: core.AlignCenter, Gap: 16, Margin: core.Edges{Bottom: 44}}, Children: []core.Node{
					a.brandMark(64, "empty-chat-logo"),
					core.Text{ContentFunc: func() string {
						if ws := a.workspaceFor(s.Target, s.WS); ws != nil && !ws.Chat {
							return apptext.T("在 %s 里做点什么", ws.label())
						}
						return apptext.T("开始新的会话")
					}, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
						Style:     core.Style{FontSize: 22, FontWeight: ui.Medium, LineHeight: 30, TextAlign: core.TextAlignCenter},
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
		return ui.Button{Text: title, Variant: ui.ButtonOutline, TestID: "chat-starter-" + id, Disabled: hasDraft,
			OnPress: func() {
				if s.draft.GetUntracked() == "" {
					s.draft.Set(prompt)
					editor.Focus()
				}
			}}
	}
	return core.View{TestID: "chat-starter-prompts",
		Style: core.Style{Direction: core.Row, Wrap: core.Wrap, JustifyContent: core.JustifyCenter, Gap: 8,
			Width: core.Pct(100), Margin: core.Edges{Bottom: 26}},
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

// welcome is shown when there is no session at all.
func (a *app) welcome() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		hasWorkspace := len(a.workspaces.Get()) > 0
		sub := apptext.T("先添加一个项目文件夹，再开会话。")
		if hasWorkspace {
			sub = apptext.T("打开一个会话，或者新建一个。")
		}
		return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Padding: core.All(32)},
			StyleFunc: func() core.Style { return core.Style{Background: colors.Background()} },
			Children: []core.Node{
				core.View{Style: core.Style{AlignItems: core.AlignCenter, Gap: 14, MaxWidth: core.Pt(420)}, Children: []core.Node{
					a.brandMark(64, "welcome-logo"),
					core.Text{Content: "PiDeck Lite", Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 22, FontWeight: ui.Bold, LetterSpacing: 0.4},
						StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: sub, Style: core.Style{FontSize: 13, TextAlign: core.TextAlignCenter, LineHeight: 20}, StyleFunc: ui.Colored(colors.Muted)},
					core.View{Style: core.Style{Direction: core.Row, Gap: 8}, Children: []core.Node{
						core.Dynamic(func(*core.Scope) core.Node {
							if hasWorkspace {
								return ui.Button{Text: apptext.T("新建会话"), Variant: ui.ButtonPrimary, TestID: "welcome-primary", OnPress: func() {
									path := a.activeWS.Get()
									if path == "" {
										if list := a.workspaces.Get(); len(list) > 0 {
											path = list[0].Path
										}
									}
									a.newSession(path)
								}}
							}
							return ui.Button{Text: apptext.T("添加工作区"), Variant: ui.ButtonPrimary, TestID: "welcome-primary", OnPress: func() { a.pickNative("workspace") }}
						}),
						ui.Button{Text: apptext.T("直接对话"), Variant: ui.ButtonSecondary, TestID: "welcome-chat", OnPress: func() { a.openChat() }},
						ui.Button{Text: apptext.T("导入会话"), Variant: ui.ButtonSecondary, TestID: "welcome-secondary", OnPress: func() { a.openImportDialog() }},
					}},
					core.Text{Content: apptext.T("NSGo 原生窗口 · 不是 Electron · 会话由本机 pi 的 RPC 模式驱动"),
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10, TextAlign: core.TextAlignCenter, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
				}},
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
