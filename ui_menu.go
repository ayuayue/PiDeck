//go:build !js

package main

// Menus and popovers: one card style for every right-click menu, and the
// pickers the composer opens — models, projects, usage — built here so they
// can show what the app knows (providers, context, favourites) instead of a
// plain list of strings.

import (
	"fmt"
	"sort"
	"strings"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// menuCard is the surface every menu and popover shares: a raised card with
// a hairline, a soft shadow and tight padding.
func (a *app) menuCard(cx *core.Scope) core.Style {
	colors := ui.ColorsOf(cx)
	return core.Style{
		Padding:      core.Symmetric(5, 5),
		CornerRadius: 10,
		BorderWidth:  1,
		BorderColor:  colors.Border(),
		Background:   colors.Surface(),
		Shadows:      []core.BoxShadow{ui.Shadow(0, 12, 32, 0, ui.Black(0.14))},
	}
}

// menuPopup is the style a context menu's popup is given.
func (a *app) menuPopup(cx *core.Scope) core.Style {
	return core.Style{Gap: 1, MinWidth: core.Pt(196)}
}

// menuRow is one row of a menu: a glyph, a label, an optional hint and the
// danger tone for what cannot be undone.
func (a *app) menuRow(cx *core.Scope, icon func() *core.SVG, label, hint string, danger bool, onPress func()) base.MenuItem {
	colors := ui.ColorsOf(cx)
	label, hint = T(label), T(hint)
	ink := colors.Text()
	glyph := colors.Muted()
	if danger {
		ink, glyph = colors.Danger(), colors.Danger()
	}
	var children []core.Node
	if icon != nil {
		children = append(children, core.View{Style: core.Style{Width: core.Pt(16), AlignItems: core.AlignCenter},
			Children: []core.Node{ui.Icon(icon, 13.5, func() core.Color { return glyph })}})
	}
	children = append(children, core.Text{Content: label, Style: core.Style{FontSize: 12.5, FlexGrow: 1},
		StyleFunc: func() core.Style { return core.Style{Color: ink} }})
	if hint != "" {
		children = append(children, core.Text{Content: hint, Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5},
			StyleFunc: ui.Colored(colors.Faint)})
	}
	return base.MenuItem{
		Label: label, OnSelect: onPress, Children: children,
		Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(28),
			Padding: core.Symmetric(0, 8), CornerRadius: 6},
		StyleFunc: func() core.Style {
			return core.Style{Hover: &core.Style{Background: colors.Hover()},
				Active: &core.Style{Background: colors.Pressed()},
				Focus:  &core.Style{Background: colors.Hover()}, Transition: pressMotion}
		},
	}
}

// pressIcon is an icon action with a springing press, for the app's own
// toolbars and row actions.
func (a *app) pressIcon(icon func() *core.SVG, label string, size, iconSize core.Points, disabled func() bool,
	press func(), testID string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return ui.Press{
		OnPress: press, Disabled: disabled, Scale: 0.88, Role: core.RoleButton, Label: label, TestID: testID,
		Style: core.Style{Width: core.Pt(size), Height: core.Pt(size), AlignItems: core.AlignCenter,
			JustifyContent: core.JustifyCenter, CornerRadius: 6},
		StyleFunc: func() core.Style {
			return core.Style{Transition: pressMotion, Hover: &core.Style{Background: colors.Hover()},
				Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{ui.Icon(icon, iconSize, colors.Muted)},
	}
}

// menuShape is the trigger's look for a menu or popover: a quiet chip.
func (a *app) menuTrigger(text func() string, icon func() *core.SVG, badge func() string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		children := []core.Node{}
		if icon != nil {
			children = append(children, ui.IconOf(icon, 12, colors.Muted))
		}
		if text != nil {
			t := core.Text{ContentFunc: text, MaxLines: 1, Style: core.Style{FontSize: 12, MinWidth: core.Pt(0), FlexShrink: 1},
				StyleFunc: ui.Colored(colors.Muted)}
			children = append(children, t)
		}
		if badge != nil {
			children = append(children, core.Text{ContentFunc: badge, MaxLines: 1,
				Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)})
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5},
			Children: children}
	})
}

// popoverCard builds a popover with the app's menu card, a trigger and the
// content of the popup.
func (a *app) popoverCard(open *core.Signal[bool], placement core.Placement, align core.Align, width core.Points,
	trigger core.Node, content func(cx *core.Scope) core.Node, testID string) core.Node {
	return base.Popover{
		Open:         open.Get,
		OnOpenChange: func(v bool, _ base.Reason) { open.Set(v) },
		Placement:    placement,
		Align:        align,
		Offset:       6,
		Margin:       8,
		Trigger:      trigger,
		PopupStyleFunc: func() core.Style {
			return a.menuCard(a.cx)
		},
		PopupStyle: core.Style{MinWidth: core.Pt(width)},
		TestID:     testID,
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			if !open.Get() {
				return nil
			}
			return content(cx)
		})},
	}
}

// modelMenu is the model picker: grouped by provider, starred first, with
// the provider's name on every group and on the trigger.
func (a *app) modelMenu(s *session, open *core.Signal[bool]) core.Node {
	trigger := core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		m := s.model.Get()
		provider := m.Provider
		label := T("选择模型")
		if m.ID != "" {
			label = modelLabel(m)
		}
		children := []core.Node{ui.Icon(lucide.Sparkles, 12, colors.Muted)}
		if provider != "" {
			children = append(children, core.Text{Content: provider, Style: core.Style{FontFamily: ui.Mono, FontSize: 10},
				StyleFunc: ui.Colored(colors.Faint)})
			children = append(children, core.Text{Content: "·", Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)})
		}
		children = append(children,
			core.Text{Content: label, MaxLines: 1, Style: core.Style{FontSize: 12, MinWidth: core.Pt(0), FlexShrink: 1},
				StyleFunc: ui.Colored(colors.Text)},
			ui.Icon(lucide.ChevronDown, 10, colors.Faint))
		return core.View{OnPress: func(core.PressEvent) {
			open.Update(func(v bool) bool { return !v })
			if open.GetUntracked() {
				s.modelQuery.Set("")
			}
		},
			Role: core.RoleButton, Label: T("选择模型"), TestID: "model-picker",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(26), MinWidth: core.Pt(0),
					Padding: core.Symmetric(0, 7), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
			},
			Children: children}
	})
	return a.popoverCard(open, core.PlaceTop, core.AlignStart, 380, trigger, func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		// The field is built once, bound to a signal on the session: typing
		// filters the list below without rebuilding (and unfocusing) it.
		search := core.View{StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(30), Padding: core.Symmetric(0, 8),
				Margin: core.Edges{Bottom: 4}, CornerRadius: 6, BorderWidth: 1, BorderColor: colors.FieldBorder(), Background: colors.Field()}
		}, Children: []core.Node{
			ui.Icon(lucide.Search, 12, colors.Faint),
			core.Input{
				Value: s.modelQuery.Get, OnChange: s.modelQuery.Set,
				Placeholder: T("搜索模型或供应商"), Label: T("搜索模型"), AutoFocus: true, TestID: "model-search",
				Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 12, Color: colors.Text()},
				StyleFunc: func() core.Style {
					return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
				},
			},
		}}
		list := core.Dynamic(func(cx *core.Scope) core.Node {
			query := strings.ToLower(strings.TrimSpace(s.modelQuery.Get()))
			colors := ui.ColorsOf(cx)
			models := append([]modelInfo(nil), s.models.Get()...)
			a.orderModels(models)
			match := func(m modelInfo) bool {
				if query == "" {
					return true
				}
				return strings.Contains(strings.ToLower(m.label()), query) || strings.Contains(strings.ToLower(m.Provider), query)
			}
			row := func(m modelInfo) core.Node {
				sel := func() bool { return s.model.Get().ID == m.ID && s.model.Get().Provider == m.Provider }
				return core.View{
					OnPress: func(core.PressEvent) {
						a.applyModel(s, m.Provider, m.ID, true)
						open.Set(false)
					},
					Role: core.RoleOption, Label: m.label(),
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(38),
							Padding: core.Symmetric(3, 8), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
					},
					Children: []core.Node{
						core.View{Style: core.Style{Width: core.Pt(14), AlignItems: core.AlignCenter}, Children: []core.Node{
							core.Dynamic(func(*core.Scope) core.Node {
								if sel() {
									return ui.Icon(lucide.Check, 12, colors.Text)
								}
								return nil
							}),
						}},
						// The name over the path it comes by: supplier and the
						// model id, which carries the routing group too.
						core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
							core.Text{Content: modelLabel(m), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
								Style: core.Style{FontSize: 12.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Text)},
							core.Text{Content: modelPath(m), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, LineHeight: 13}, StyleFunc: ui.Colored(colors.Faint)},
						}},
						core.Text{Content: tokens(m.ContextWindow), Style: core.Style{FontFamily: ui.Mono, FontSize: 10, FlexShrink: 0},
							StyleFunc: ui.Colored(colors.Faint)},
						core.View{OnPress: func(core.PressEvent) { a.toggleFavModel(m) }, Role: core.RoleButton, Label: T("收藏模型"),
							StyleFunc: func() core.Style {
								return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
									JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
							},
							Children: []core.Node{core.Dynamic(func(*core.Scope) core.Node {
								if a.isFavModel(m) {
									return ui.Icon(lucide.Star, 12, colors.Text)
								}
								return ui.Icon(lucide.StarOff, 12, colors.Faint)
							})}},
					},
				}
			}
			var rows []core.Node
			favs := []modelInfo{}
			groups := map[string][]modelInfo{}
			var order []string
			for _, m := range models {
				if !match(m) {
					continue
				}
				if a.isFavModel(m) {
					favs = append(favs, m)
					continue
				}
				if _, ok := groups[m.Provider]; !ok {
					order = append(order, m.Provider)
				}
				groups[m.Provider] = append(groups[m.Provider], m)
			}
			groupHeader := func(text string) core.Node {
				return core.View{Style: core.Style{Padding: core.Symmetric(6, 8), Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6},
					Children: []core.Node{
						core.Text{Content: text, Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, LetterSpacing: 0.6},
							StyleFunc: ui.Colored(colors.Faint)},
						core.View{Style: core.Style{FlexGrow: 1, Height: core.Pt(1)}, StyleFunc: ui.Filled(colors.Line)},
					}}
			}
			if len(favs) > 0 {
				rows = append(rows, groupHeader(T("★ 常用")))
				for _, m := range favs {
					rows = append(rows, row(m))
				}
			}
			sort.SliceStable(order, func(i, j int) bool {
				ri, rj := a.providerRank(order[i]), a.providerRank(order[j])
				if ri != rj {
					return ri < rj
				}
				return order[i] < order[j]
			})
			for _, p := range order {
				rows = append(rows, groupHeader(p))
				for _, m := range groups[p] {
					rows = append(rows, row(m))
				}
			}
			if len(rows) == 0 {
				rows = append(rows, core.Text{Content: T("没有匹配的模型"), Style: core.Style{FontSize: 11.5, Padding: core.All(8)},
					StyleFunc: ui.Colored(colors.Faint)})
			}
			return core.Scroll{Style: core.Style{MaxHeight: core.Pt(380), MinWidth: core.Pt(0)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: rows},
			}}
		})
		refresh := core.Dynamic(func(cx *core.Scope) core.Node {
			if s.backend == "acp" {
				return nil
			}
			colors := ui.ColorsOf(cx)
			busy := s.modelsBusy.Get()
			var lead core.Node = ui.Icon(lucide.RotateCw, 11, colors.Muted)
			if busy {
				lead = ui.Spinner{Size: 11}
			}
			return core.View{
				OnPress: func(core.PressEvent) { a.refreshModels(s) },
				Role:    core.RoleButton, Label: T("刷新模型"), TestID: "model-refresh",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(30),
						Margin: core.Edges{Top: 4}, Padding: core.Symmetric(0, 8), CornerRadius: 6,
						BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					lead,
					core.Text{Content: T("刷新模型"), Style: core.Style{FontSize: 11.5, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Muted)},
					core.Text{ContentFunc: func() string { return fmt.Sprintf("%d 个", len(s.models.Get())) },
						Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
				},
			}
		})
		return core.View{Style: core.Style{MinWidth: core.Pt(0)}, Children: []core.Node{search, list, refresh}}
	}, "model-menu")
}

// providerRank is where a provider sits in the user's order: named ones
// by their place, the rest after them alphabetically.
func (a *app) providerRank(id string) int {
	for i, p := range a.cfg.ProviderOrder {
		if p == id {
			return i
		}
	}
	return len(a.cfg.ProviderOrder) + 1
}

// favRank is where a model sits in the user's favourites: -1 when it is
// not one.
func (a *app) favRank(m modelInfo) int {
	key := m.Provider + "/" + m.ID
	for i, k := range a.favModels.GetUntracked() {
		if k == key {
			return i
		}
	}
	return -1
}

// orderModels sorts models the way the picker shows them: favourites in
// the user's own order, then each provider in the user's order, and
// within a provider by name.
func (a *app) orderModels(models []modelInfo) {
	sort.SliceStable(models, func(i, j int) bool {
		fi, fj := a.favRank(models[i]), a.favRank(models[j])
		if (fi >= 0) != (fj >= 0) {
			return fi >= 0
		}
		if fi >= 0 && fj >= 0 && fi != fj {
			return fi < fj
		}
		ri, rj := a.providerRank(models[i].Provider), a.providerRank(models[j].Provider)
		if ri != rj {
			return ri < rj
		}
		if models[i].Provider != models[j].Provider {
			return models[i].Provider < models[j].Provider
		}
		return strings.ToLower(modelLabel(models[i])) < strings.ToLower(modelLabel(models[j]))
	})
}

// modelPath is where a model comes from: its supplier and the id pi
// knows it by, which carries the routing group ("magpie · zui/…").
func modelPath(m modelInfo) string {
	if m.Provider == "" {
		return m.ID
	}
	return m.Provider + " · " + m.ID
}

// modelLabel is a model's name without the routing suffix pi appends.
func modelLabel(m modelInfo) string {
	name := m.label()
	if i := strings.Index(name, " · "); i > 0 {
		name = name[:i]
	}
	return name
}

// usageMenu is the composer's usage panel: what the context holds, what the
// session has spent, and the actions that follow from it.
func (a *app) usageMenu(s *session, open *core.Signal[bool]) core.Node {
	trigger := core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		u := s.usage.Get()
		total := tokens(u.Total)
		if u.Total == 0 {
			total = T("用量")
		}
		return core.View{OnPress: func(core.PressEvent) { open.Update(func(v bool) bool { return !v }) },
			Role: core.RoleButton, Label: T("用量"), TestID: "usage-chip",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(24),
					Padding: core.Symmetric(0, 7), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
			},
			Children: []core.Node{
				ui.Icon(lucide.Gauge, 12, colors.Muted),
				core.Text{Content: total, Style: core.Style{FontFamily: ui.Mono, FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
				core.Text{Content: credits(u.Cost), Style: core.Style{FontFamily: ui.Mono, FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
			}}
	})
	return a.popoverCard(open, core.PlaceTop, core.AlignEnd, 300, trigger, func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		st := s.stats.Get()
		u := s.usage.Get()
		m := s.model.Get()
		ctxTokens, ctxWindow := st.ContextTokens, st.ContextWindow
		if ctxWindow == 0 && m.ContextWindow > 0 {
			ctxWindow = m.ContextWindow
		}
		fraction := 0.0
		if ctxWindow > 0 {
			fraction = min(1, float64(ctxTokens)/float64(ctxWindow))
		}
		row := func(label, value string, accent func() core.Color) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(24)}, Children: []core.Node{
				core.Text{Content: label, Style: core.Style{FontSize: 12, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Muted)},
				core.Text{Content: value, Style: core.Style{FontFamily: ui.Mono, FontSize: 11}, StyleFunc: ui.Colored(accent)},
			}}
		}
		turns, tools := 0, 0
		for _, t := range s.turns.Get() {
			turns++
			tools += t.Tools
		}
		return core.View{Style: core.Style{Width: core.Pt(288), Gap: 8}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Text(T("用量"), 12.5, ui.Semibold, colors.Text),
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Text(modelLabel(m), 10.5, ui.Regular, colors.Faint),
			}},
			core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter}, Children: []core.Node{
					ui.Text("上下文", 12, ui.Regular, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1}},
					ui.Textf(func() string {
						if ctxWindow == 0 {
							return T("未测量")
						}
						return fmt.Sprintf("%s / %s · %.0f%%", tokens(ctxTokens), tokens(ctxWindow), fraction*100)
					}, 10.5, ui.Regular, colors.Faint),
				}},
				core.View{Style: core.Style{Height: core.Pt(5), CornerRadius: 3, Background: colors.Track(), Overflow: core.Hidden},
					Children: []core.Node{core.View{StyleFunc: func() core.Style {
						c := colors.Accent()
						if fraction >= 0.95 {
							c = colors.Danger()
						} else if fraction >= 0.8 {
							c = colors.Warn()
						}
						return core.Style{Width: core.Pct(float32(fraction * 100)), Height: core.Pt(5), Background: c}
					}}}},
			}},
			core.View{Style: core.Style{Height: core.Pt(1)}, StyleFunc: ui.Filled(colors.Line)},
			core.View{Style: core.Style{Gap: 1}, Children: []core.Node{
				row("输入", tokens(u.Input), colors.Text),
				row("输出", tokens(u.Output), colors.Text),
				row("缓存读", tokens(u.CacheRead), colors.Muted),
				row("费用", credits(u.Cost), colors.Text),
				row(T("轮次 / 工具"), fmt.Sprintf("%d / %d", turns, tools), colors.Muted),
			}},
			core.View{Style: core.Style{Height: core.Pt(1)}, StyleFunc: ui.Filled(colors.Line)},
			core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: []core.Node{
				ui.Button{Text: T("压缩上下文"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
					open.Set(false)
					a.compact(s)
				}},
				ui.Button{Text: T("会话面板"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
					open.Set(false)
					a.drawer.Set(true)
					a.drawerTab.Set("overview")
				}},
			}},
		}}
	}, "usage-menu")
}

// projectMenu switches the session's project from the composer.
func (a *app) projectMenu(s *session, open *core.Signal[bool]) core.Node {
	trigger := core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		name := T("选择项目")
		badge := ""
		if ws := a.workspaceFor(s.Target, s.WS); ws != nil {
			name = ws.label()
			badge = ws.Target.shortLabel()
		}
		children := []core.Node{
			ui.Icon(lucide.Folder, 12, colors.Muted),
			core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontSize: 12, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Muted)},
		}
		if badge != "" {
			children = append(children, core.View{StyleFunc: func() core.Style {
				return core.Style{Padding: core.Symmetric(0, 3), CornerRadius: 3, Background: colors.Inset()}
			}, Children: []core.Node{ui.Text(badge, 8.5, ui.Medium, colors.Faint)}})
		}
		return core.View{OnPress: func(core.PressEvent) { open.Update(func(v bool) bool { return !v }) },
			Role: core.RoleButton, Label: T("项目"), TestID: "project-chip",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(24),
					Padding: core.Symmetric(0, 7), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
			},
			Children: children}
	})
	return a.popoverCard(open, core.PlaceTop, core.AlignStart, 280, trigger, func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		list := a.workspaces.Get()
		var rows []core.Node
		for _, ws := range list {
			w := ws
			sel := func() bool { return a.activeWS.Get() == w.Path }
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) {
					a.activeWS.Set(w.Path)
					if !w.Target.remote() {
						a.files.watch(w.Path)
					}
					open.Set(false)
				},
				Role: core.RoleOption, Label: w.label(),
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(30),
						Padding: core.Symmetric(0, 8), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					ui.Icon(lucide.Folder, 13, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: w.label(), MaxLines: 1, Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: shortPath(w.Path, 40), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					}},
					core.Show{When: sel, Then: func(*core.Scope) core.Node { return ui.Icon(lucide.Check, 12, colors.Text) }},
				},
			})
		}
		rows = append(rows, core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Edges{Top: 4, Bottom: 4}}, StyleFunc: ui.Filled(colors.Line)})
		rows = append(rows, core.View{
			OnPress: func(core.PressEvent) { open.Set(false); a.pickNative("workspace") },
			Role:    core.RoleButton, Label: T("添加项目"),
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(30),
					Padding: core.Symmetric(0, 8), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
			},
			Children: []core.Node{
				ui.Icon(lucide.Plus, 13, colors.Muted),
				ui.Text(T("添加项目…"), 12.5, ui.Regular, colors.Text),
			},
		})
		if len(list) == 0 {
			rows = append([]core.Node{core.Text{Content: T("还没有项目"), Style: core.Style{FontSize: 11.5, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)}}, rows...)
		}
		return core.View{Style: core.Style{Width: core.Pt(268)}, Children: []core.Node{core.View{Style: core.Style{Gap: 1}, Children: rows}}}
	}, "project-menu")
}

// sessionMenuItems is a session's right-click menu, shared by the sessions
// the app owns and the ones pi does.
func (a *app) sessionMenuItems(sess func() *session) []core.Node {
	colors := ui.ColorsOf(a.cx)
	// The item's own colors come from the app's scope: menus are built once.
	_ = colors
	return []core.Node{
		a.menuRow(a.cx, lucide.Star, pinLabel(a, sess), "", false, func() { a.togglePin(sess()) }),
		a.menuRow(a.cx, lucide.Star, sessionFavoriteLabel(a, sess), "", false, func() { a.toggleSessionFavorite(sess()) }),
		a.menuRow(a.cx, lucide.Pencil, "重命名", "", false, func() { a.askRename(sess()) }),
		a.menuRow(a.cx, lucide.Copy, "复制会话 ID", "", false, func() { a.copyText(sess().ID, "会话 ID") }),
		a.menuRow(a.cx, lucide.CopyPlus, "复制会话", "", false, func() { a.duplicateSession(sess()) }),
		a.menuRow(a.cx, lucide.FileDown, "导出…", "", false, func() { a.openExport(sess()) }),
		a.menuRow(a.cx, lucide.FolderOpen, "在文件管理器中显示", "", false, func() { a.revealSession(sess()) }),
		a.menuRow(a.cx, lucide.Copy, "复制工作目录", "", false, func() { a.copyText(sess().WS, "路径") }),
		a.menuRow(a.cx, lucide.Archive, archiveLabel(a, sess), "", false, func() { a.toggleArchive(sess()) }),
		a.menuRow(a.cx, lucide.Trash, "删除会话", "", true, func() { a.deleteSession(sess()) }),
	}
}

// archiveLabel names the archive action for the state a session is in.
func archiveLabel(a *app, sess func() *session) string {
	if a.sessionArchived(sess().ID) {
		return "取消归档"
	}
	return "归档"
}

// showArchivedLabel names the rail's archived-sessions toggle.
func showArchivedLabel(a *app) string {
	if a.cfg.ShowArchived {
		return "隐藏已归档"
	}
	return "显示已归档"
}

// pinLabel names the pin action for the state a session is in.
func pinLabel(a *app, sess func() *session) string {
	if a.isPinned(sess().ID) {
		return T("取消置顶会话")
	}
	return T("置顶会话")
}

// sessionFavoriteLabel names the favorites action for the state.
func sessionFavoriteLabel(a *app, sess func() *session) string {
	if a.isSessionFavorite(sess().ID) {
		return T("移出收藏夹")
	}
	return T("存入收藏夹")
}

// sortLabel names the sort action for the current order.
func sortLabel(a *app) string {
	if a.cfg.SessionSort == "name" {
		return "按最近活动排序"
	}
	return "按名称排序"
}

// menuSeparator is the hairline between groups of items.
func (a *app) menuSeparator(cx *core.Scope) base.MenuSeparator {
	colors := ui.ColorsOf(cx)
	return base.MenuSeparator{Style: core.Style{Height: core.Pt(1), Margin: core.Symmetric(4, 6)},
		StyleFunc: ui.Filled(colors.Line)}
}

// projectMenuItems is a project's right-click menu.
// trustMenuItem names the project menu's trust action.
func (a *app) trustMenuItem(w *workspace) string {
	if w == nil {
		return T("信任项目")
	}
	if w.Chat {
		return T("内置对话始终受信任")
	}
	if a.projectTrusted(w) {
		return T("撤销信任")
	}
	return T("信任项目")
}

func (a *app) projectMenuItems(w func() *workspace) []core.Node {
	return []core.Node{
		a.menuRow(a.cx, lucide.SquarePen, "在此新建会话", "", false, func() { a.newSession(w().Path) }),
		a.menuRow(a.cx, lucide.SquareTerminal, "在此打开终端", "", false, func() { a.openTerminalFor(w()) }),
		a.menuRow(a.cx, lucide.GitBranch, "查看 Git 变更", "", false, func() { a.openGitFor(w()) }),
		a.menuSeparator(a.cx),
		a.menuRow(a.cx, lucide.Pin, pinProjectLabel(w()), "", false, func() { a.toggleProjectPin(w()) }),
		a.menuRow(a.cx, lucide.ShieldCheck, a.trustMenuItem(w()), "", w().Chat, func() { a.toggleProjectTrust(w()) }),
		a.menuRow(a.cx, lucide.ChevronUp, "上移项目", "", false, func() { a.moveProject(w(), -1) }),
		a.menuRow(a.cx, lucide.ChevronDown, "下移项目", "", false, func() { a.moveProject(w(), 1) }),
		a.menuRow(a.cx, lucide.FolderInput, "移动到分组…", "", false, func() { a.askProjectGroup(w()) }),
		a.menuRow(a.cx, lucide.Pencil, "重命名项目…", "", w().Chat, func() { a.askWorkspaceName(w()) }),
		a.menuRow(a.cx, lucide.ArrowDownAZ, projectSortLabel(a), "", false, func() { a.cycleProjectSort() }),
		a.menuSeparator(a.cx),
		a.menuRow(a.cx, lucide.RefreshCw, "刷新会话", "", false, func() {
			w().piLoaded = false
			a.scanProject(w())
		}),
		a.menuRow(a.cx, lucide.ArrowDownAZ, sortLabel(a), "", false, func() { a.toggleSessionSort() }),
		a.menuRow(a.cx, lucide.Archive, showArchivedLabel(a), "", false, func() { a.toggleShowArchived() }),
		a.menuRow(a.cx, lucide.Archive, "已归档…", "", false, func() { a.openArchiveDialog() }),
		a.menuSeparator(a.cx),
		a.menuRow(a.cx, lucide.Code, "在编辑器中打开项目", "", false, func() { a.openPathInEditor(w().Path) }),
		a.menuRow(a.cx, lucide.FolderOpen, "在文件管理器中打开", "", false, func() { a.revealProject(w()) }),
		a.menuRow(a.cx, lucide.Copy, "复制项目路径", "", false, func() { a.copyText(w().Path, "路径") }),
		a.menuRow(a.cx, lucide.FolderPlus, T("添加项目…"), "", false, func() { a.pickNative("workspace") }),
		a.menuSeparator(a.cx),
		a.menuRow(a.cx, lucide.FolderMinus, "移除项目", "", true, func() { a.removeWorkspace(w()) }),
	}
}
