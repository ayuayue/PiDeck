//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"fmt"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// drawerOverview is the active session's totals and actions.
func (a *app) drawerOverview() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		s := a.active()
		if s == nil {
			return core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(apptext.T("没有打开的会话"), 12.5, ui.Regular, ui.ColorsOf(cx).Muted),
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
				return fmt.Sprintf("%s / %s (%.0f%%)", viewkit.Tokens(st.ContextTokens), viewkit.Tokens(st.ContextWindow), st.ContextPercent)
			}
			u := s.usage.Get()
			m := s.model.Get()
			if u.Total > 0 && m.ContextWindow > 0 {
				return fmt.Sprintf("%s / %s", viewkit.Tokens(u.Total), viewkit.Tokens(m.ContextWindow))
			}
			return apptext.T("还没有用量")
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
				return apptext.T("未选择")
			}
			return m.label()
		}
		return a.scrollStashFor("drawerOverview:1").bind(cx, core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Gap: 14, Padding: core.Edges{Top: 2, Bottom: 20, Right: 2, Left: 2}}, Children: []core.Node{
				core.View{StyleFunc: func() core.Style {
					return core.Style{Gap: 4, Padding: core.All(12), CornerRadius: ui.RadiusControl, Background: colors.Surface(), BorderWidth: 1, BorderColor: colors.Border()}
				}, Children: []core.Node{
					core.Text{ContentFunc: func() string { return s.title.Get() }, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 13, FontWeight: ui.Semibold, LineHeight: 19}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{ContentFunc: func() string { return shortPath(s.WS, 44) }, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
				}},
				core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
					a.delegationOverview(s),
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(24)}, Children: []core.Node{
						core.Text{Content: apptext.T("模型"), Style: core.Style{FontSize: 12, Width: core.Pt(74)}, StyleFunc: ui.Colored(colors.Muted)},
						core.Text{ContentFunc: models, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
						core.View{OnPress: func(core.PressEvent) { a.toggleFavModel(s.model.Get()) }, Role: core.RoleButton, Label: apptext.T("收藏模型"),
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
					row(apptext.T("思考"), func() string {
						if t := s.thinking.Get(); t != "" {
							return levelLabel(t)
						}
						return apptext.T("默认")
					}),
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(24)}, Children: []core.Node{
						core.Text{Content: apptext.T("会话 ID"), Style: core.Style{FontSize: 12, Width: core.Pt(74)}, StyleFunc: ui.Colored(colors.Muted)},
						core.Text{ContentFunc: func() string { return s.ID }, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 10.5}, StyleFunc: ui.Colored(colors.Text)},
						core.View{OnPress: func(core.PressEvent) { a.copyText(s.ID, "会话 ID") }, Role: core.RoleButton, Label: apptext.T("复制会话 ID"),
							TestID: "overview-copy-id",
							StyleFunc: func() core.Style {
								return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
									JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Hover()}}
							}, Children: []core.Node{ui.Icon(lucide.Copy, 12, colors.Faint)}},
					}},
					core.Show{When: func() bool { return s.File != "" }, Then: func(*core.Scope) core.Node {
						return row(apptext.T("会话文件"), func() string { return shortPath(s.File, 48) })
					}},
					core.Show{When: func() bool { return a.cfg.ForkParents[s.ID] != "" }, Then: func(cx *core.Scope) core.Node {
						parentID := a.cfg.ForkParents[s.ID]
						title := a.cfg.Titles[parentID]
						if p := a.byID[parentID]; p != nil {
							title = p.title.Get()
						}
						if title == "" {
							title = apptext.T("原会话")
						}
						children := []core.Node{
							ui.Icon(lucide.GitBranch, 11, colors.Faint),
							core.Text{Content: apptext.T("分叉自 %s", title), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
								Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
						}
						if a.byID[parentID] != nil {
							children = append(children, ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
								TestID: "fork-parent", OnPress: func() {
									if p := a.byID[parentID]; p != nil {
										a.selectSession(p)
									}
								}})
						}
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: children}
					}},
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
				a.sessionRelations(s),
				core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter}, Children: []core.Node{
						ui.Text(apptext.T("上下文"), 12, ui.Regular, colors.Muted),
						core.View{Style: core.Style{FlexGrow: 1}},
						core.Text{ContentFunc: contextText, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
					}},
					bar(),
				}},
				core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
					row(apptext.T("输入"), func() string { return viewkit.Tokens(s.usage.Get().Input) + " tokens" }),
					row(apptext.T("输出"), func() string { return viewkit.Tokens(s.usage.Get().Output) + " tokens" }),
					row(apptext.T("缓存读"), func() string { return viewkit.Tokens(s.usage.Get().CacheRead) + " tokens" }),
					row(apptext.T("费用"), func() string { return viewkit.Credits(s.usage.Get().Cost) }),
					row(apptext.T("工具调用"), func() string {
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
					ui.Button{Text: apptext.T("视频生成"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "session-videos", OnPress: func() { a.openPane(paneVideo) }},
					ui.Button{Text: apptext.T("压缩上下文"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.compact(s) }},
					ui.Button{Text: apptext.T("导出…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "export-button",
						OnPress: func() { a.openExport(s) }},
					ui.Button{Text: apptext.T("重命名"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.askRename(s) }},
					ui.Button{Text: apptext.T("文件"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.drawerTab.Set("files") }},
					ui.Button{Text: "Git", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.openGit() }},
					ui.Button{Text: apptext.T("终端"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.toggleTerminal() }},
				}},
				a.videoSessionRows(s),
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap}, Children: []core.Node{
					core.Text{ContentFunc: func() string { return shortPath(s.File, 46) }, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, LineHeight: 14}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			}},
		}})
	})
}
