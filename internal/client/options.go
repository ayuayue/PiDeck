package client

// The phone build: it connects to a desktop PiDeck Lite server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_LITE_MOBILE=1 for a preview on a desktop).

import (
	"fmt"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// retryBar offers the last prompt again after a failed turn.
func (a *mobileApp) retryBar(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.Show{When: func() bool {
		msgs := a.messages.Get()
		return len(msgs) > 0 && msgs[len(msgs)-1].Role == "error" && a.lastPrompt() != ""
	}, Then: func(*core.Scope) core.Node {
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(2, 12)},
			Children: []core.Node{
				ui.Button{Text: apptext.T("重试上一条"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "mobile-retry",
					OnPress: func() {
						text := a.lastPrompt()
						if text == "" {
							return
						}
						a.draft.Set(text)
						a.sendMessage()
					}},
				ui.Text(apptext.T("这一轮失败了"), 10.5, ui.Regular, colors.Faint),
			}}
	}}
}

// lastPrompt is the newest user message, the one a retry re-sends.
func (a *mobileApp) lastPrompt() string {
	msgs := a.messages.GetUntracked()
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			return strings.TrimSpace(msgs[i].Text)
		}
	}
	return ""
}

// sessionBar is the model and thinking line over the composer.
func (a *mobileApp) sessionBar(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	label := func() string {
		opts := a.options.Get()
		name := opts.Model
		for _, m := range opts.Models {
			if m.ID == opts.Model {
				name = m.Name
				break
			}
		}
		if name == "" {
			name = "默认模型"
		}
		if opts.Thinking != "" {
			name += " · " + opts.Thinking
		}
		return name
	}
	return core.View{OnPress: func(core.PressEvent) { a.openOptions() }, Role: core.RoleButton, Label: apptext.T("模型与思考等级"),
		TestID: "mobile-options",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Padding: core.Symmetric(4, 12),
				Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.Icon(lucide.Brain, 11, colors.Faint),
			core.Text{ContentFunc: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexShrink: 1, FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
			ui.Icon(lucide.ChevronUp, 11, colors.Faint),
			a.usageChip(),
		}}
}

// sessionStatsLabel names a session's context use and cost.
func sessionStatsLabel(tokenCount, context, window int, cost float64) string {
	var parts []string
	switch {
	case window > 0 && context > 0:
		parts = append(parts, viewkit.Tokens(context)+" / "+viewkit.Tokens(window))
	case tokenCount > 0:
		parts = append(parts, viewkit.Tokens(tokenCount)+" tokens")
	}
	if cost > 0 {
		parts = append(parts, fmt.Sprintf("$%.2f", cost))
	}
	return strings.Join(parts, " · ")
}

// usageChip shows the active session's context and cost.
func (a *mobileApp) usageChip() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		id := a.active.Get()
		var found *remotewire.Session
		for _, p := range a.state.Get().Projects {
			for i := range p.Sessions {
				if p.Sessions[i].ID == id {
					cp := p.Sessions[i]
					found = &cp
					break
				}
			}
		}
		if found == nil {
			return nil
		}
		label := sessionStatsLabel(found.Tokens, found.Context, found.ContextWindow, found.Cost)
		if label == "" {
			return nil
		}
		return core.View{TestID: "mobile-usage", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
			ui.Icon(lucide.Gauge, 10, colors.Faint),
			core.Text{Content: label, MaxLines: 1, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
		}}
	})
}

// openOptions reads the session's choices and shows them.
func (a *mobileApp) openOptions() {
	id := a.active.GetUntracked()
	if id == "" {
		return
	}
	a.optionsOpen.Set(true)
	a.loadOptions(id)
}

// loadOptions reads a session's models and thinking levels.
func (a *mobileApp) loadOptions(id string) {
	client := a.client
	if client == nil || id == "" {
		return
	}
	go func() {
		opts, err := client.options(id)
		a.cx.Post(func() {
			if a.active.GetUntracked() != id || err != nil {
				return
			}
			a.options.Set(opts)
		})
	}()
}

// optionsSheet picks the model or the thinking level.
func (a *mobileApp) optionsSheet() core.Node {
	return ui.Dialog{
		Open:         func() bool { return a.optionsOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) { a.optionsOpen.Set(open) },
		Title:        apptext.T("模型与思考"),
		TestID:       "mobile-options-sheet",
		Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			opts := a.options.Get()
			var sections []core.Node
			if len(opts.Levels) > 0 {
				chips := make([]core.Node, 0, len(opts.Levels))
				for _, level := range opts.Levels {
					l := level
					on := l == opts.Thinking
					chips = append(chips, core.View{OnPress: func(core.PressEvent) { a.chooseThinking(l) },
						Role: core.RoleButton, Label: l, TestID: "mobile-level",
						StyleFunc: func() core.Style {
							st := core.Style{Padding: core.Symmetric(6, 12), CornerRadius: 14, BorderWidth: 1,
								BorderColor: colors.FieldBorder(), Transition: viewkit.PressMotion,
								Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
							if on {
								st.Background = colors.Light()
								st.BorderColor = colors.Light()
							}
							return st
						},
						Children: []core.Node{ui.Text(l, 12, ui.Medium, func() core.Color {
							if on {
								return colors.OnLight()
							}
							return colors.Muted()
						})}})
				}
				sections = append(sections, core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					ui.Text(apptext.T("思考等级"), 11, ui.Medium, colors.Faint),
					core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: chips},
				}})
			}
			if len(opts.Models) > 0 {
				rows := make([]core.Node, 0, len(opts.Models))
				for _, m := range opts.Models {
					model := m
					on := model.ID == opts.Model
					rows = append(rows, core.View{OnPress: func(core.PressEvent) { a.chooseModel(model) },
						Role: core.RoleButton, Label: model.Name, TestID: "mobile-model",
						StyleFunc: func() core.Style {
							return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(40),
								Padding: core.Symmetric(0, 8), CornerRadius: 7, Transition: viewkit.PressMotion,
								Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
						},
						Children: []core.Node{
							core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
								core.Text{Content: model.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
									Style: core.Style{FontSize: 13.5}, StyleFunc: ui.Colored(colors.Text)},
								core.Text{Content: model.Provider, MaxLines: 1, Style: core.Style{FontSize: 10},
									StyleFunc: ui.Colored(colors.Faint)},
							}},
							core.Show{When: func() bool { return on }, Then: func(*core.Scope) core.Node {
								return ui.Icon(lucide.Check, 14, colors.Text)
							}},
						}})
				}
				sections = append(sections, core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					ui.Text(apptext.T("模型"), 11, ui.Medium, colors.Faint),
					core.Scroll{Style: core.Style{MaxHeight: core.Pt(320)}, Children: []core.Node{
						core.View{Style: core.Style{Gap: 1}, Children: rows},
					}},
				}})
			}
			if len(sections) == 0 {
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(10, 4)},
					Children: []core.Node{
						ui.Spinner{Size: 13, Label: apptext.T("正在读取")},
						ui.Text(apptext.T("正在读取模型列表…"), 12, ui.Regular, colors.Faint),
					}}
			}
			return core.View{Style: core.Style{Gap: 14}, Children: sections}
		})},
	}
}

// chooseModel switches the open session's model.
func (a *mobileApp) chooseModel(m remotewire.Model) {
	id := a.active.GetUntracked()
	client := a.client
	if id == "" || client == nil {
		return
	}
	a.optionsOpen.Set(false)
	go func() {
		err := client.setModel(id, m.Provider, m.ID)
		a.cx.Post(func() {
			if err != nil {
				a.transcriptErr.Set(remoteErrorText(err))
				return
			}
			a.loadOptions(id)
		})
	}()
}

// chooseThinking switches the open session's reasoning level.
func (a *mobileApp) chooseThinking(level string) {
	id := a.active.GetUntracked()
	client := a.client
	if id == "" || client == nil {
		return
	}
	a.optionsOpen.Set(false)
	go func() {
		err := client.setThinking(id, level)
		a.cx.Post(func() {
			if err != nil {
				a.transcriptErr.Set(remoteErrorText(err))
				return
			}
			a.loadOptions(id)
		})
	}()
}
