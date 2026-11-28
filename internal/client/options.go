package client

// The phone build: it connects to a desktop PiDeck server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

import (
	"sort"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
	"example.com/pideck/internal/viewkit"
	"example.com/pideck/internal/viewkit/brands"
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

// modelLabel is the model the open session answers with, as its chip
// shows it.
func (a *mobileApp) modelLabel() string {
	opts := a.options.Get()
	name := opts.Model
	for _, m := range opts.Models {
		if m.ID == opts.Model {
			name = m.Name
			break
		}
	}
	if name == "" {
		return apptext.T("模型")
	}
	return name
}

// thinkingLabel is the open session's reasoning level, or the word for the
// picker when it has none.
func (a *mobileApp) thinkingLabel() string {
	if level := strings.TrimSpace(a.options.Get().Thinking); level != "" {
		return level
	}
	return apptext.T("思考")
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
		parts = append(parts, viewkit.Credits(cost))
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

// openInitOptions is the new-session page's model chip. A model belongs to
// a session, so the page starts the session the first message would have
// started, keeps the draft, and then shows the choices.
func (a *mobileApp) openInitOptions() {
	client := a.client
	project := a.initProjectPath()
	switch {
	case client == nil:
		a.flash(apptext.T("还没连上电脑，先回到连接页"))
		return
	case project == "":
		a.err.Set(apptext.T("先在抽屉里添加一个项目"))
		return
	case a.initSending.GetUntracked():
		return
	}
	visit := a.sessionSeq
	a.initSending.Set(true)
	a.err.Set("")
	go func() {
		id, title, err := client.createSession(project)
		a.cx.Post(func() {
			a.initSending.Set(false)
			if a.client != client || visit != a.sessionSeq || a.active.GetUntracked() != "" {
				return
			}
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			draft, pending := a.initDraft.GetUntracked(), a.initPending.GetUntracked()
			a.initDraft.Set("")
			a.initPending.Set(nil)
			a.initProject.Set(project)
			a.saveLook()
			a.openSession(id, title)
			a.draft.Set(draft)
			a.pending.Set(pending)
			a.refreshState()
			a.openOptions()
		})
	}()
}

// loadOptions reads a session's models and thinking levels.
func (a *mobileApp) loadOptions(id string) {
	client := a.client
	if client == nil || id == "" {
		return
	}
	visit := a.sessionSeq
	go func() {
		opts, err := client.options(id)
		a.cx.Post(func() {
			if a.client != client || visit != a.sessionSeq || a.active.GetUntracked() != id || err != nil {
				return
			}
			a.options.Set(opts)
			a.mode.Set(opts.Mode)
		})
	}()
}

// sameOptions says two reads carry the same choices, so a poll that found
// nothing new leaves the sheet alone. A new value would rebuild every row
// under the reader's finger: the model list is long enough that a rebuild
// mid-scroll is what a poll looks like as the page reloading itself.
func sameOptions(a, b remotewire.Options) bool {
	return a.Model == b.Model && a.Provider == b.Provider && a.Thinking == b.Thinking &&
		a.Mode == b.Mode && a.Ready == b.Ready && a.Backend == b.Backend &&
		a.BackendName == b.BackendName && a.BackendLocked == b.BackendLocked &&
		sameStrings(a.Levels, b.Levels) && sameStrings(a.Tools, b.Tools) &&
		sameBackends(a.Backends, b.Backends) && sameModels(a.Models, b.Models)
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameModels(a, b []remotewire.Model) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameBackends(a, b []remotewire.Backend) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// optionsSheet picks the model or the thinking level.
func (a *mobileApp) optionsSheet() core.Node {
	return ui.Dialog{
		Open:         func() bool { return a.optionsOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) { a.optionsOpen.Set(open) },
		Title:        apptext.T("会话设置"),
		TestID:       "mobile-options-sheet",
		Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			opts := a.options.Get()
			var sections []core.Node
			if len(opts.Backends) > 0 {
				sections = append(sections, a.backendSection(cx, opts))
			}
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
				sections = append(sections, a.modelSection(cx, opts))
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

// modelSection lists the session's models, searchable and grouped by
// supplier: a desktop can offer a hundred and sixty of them, and a flat
// list of that length cannot be found by eye. The search field and the
// list are separate computations so typing filters the rows without
// rebuilding (and unfocusing) the field.
func (a *mobileApp) modelSection(cx *core.Scope, opts remotewire.Options) core.Node {
	colors := ui.ColorsOf(cx)
	sections := []core.Node{
		ui.Text(apptext.T("模型"), 11, ui.Medium, colors.Faint),
		// The field reads the query, so it keeps its focus while the list
		// below filters.
		core.View{StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(32), Padding: core.Symmetric(0, 9),
				CornerRadius: 8, BorderWidth: 1, BorderColor: colors.FieldBorder(), Background: colors.Field()}
		}, Children: []core.Node{
			ui.Icon(lucide.Search, 12, colors.Faint),
			core.Input{
				Value: a.optionsQuery.Get, OnChange: a.optionsQuery.Set,
				Placeholder: apptext.T("搜索模型或供应商"), Label: apptext.T("搜索模型"), TestID: "mobile-model-search",
				Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 12.5, Color: colors.Text()},
				StyleFunc: func() core.Style {
					return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
				},
			},
		}},
	}
	rows := core.Dynamic(func(cx *core.Scope) core.Node {
		query := strings.ToLower(strings.TrimSpace(a.optionsQuery.Get()))
		colors := ui.ColorsOf(cx)
		match := func(m remotewire.Model) bool {
			if query == "" {
				return true
			}
			return strings.Contains(strings.ToLower(m.Name), query) ||
				strings.Contains(strings.ToLower(m.ID), query) ||
				strings.Contains(strings.ToLower(m.Provider), query)
		}
		row := func(m remotewire.Model) core.Node {
			on := m.ID == opts.Model && m.Provider == opts.Provider
			return core.View{OnPress: func(core.PressEvent) { a.chooseModel(m) },
				Role: core.RoleButton, Label: m.Name, TestID: "mobile-model-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(42),
						Padding: core.Symmetric(0, 8), CornerRadius: 7, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					core.View{Style: core.Style{Width: core.Pt(14), AlignItems: core.AlignCenter}, Children: []core.Node{
						core.Show{When: func() bool { return on }, Then: func(*core.Scope) core.Node {
							return ui.Icon(lucide.Check, 13, colors.Text)
						}},
					}},
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						viewkit.BrandName(colors, brands.Model(m.ID, m.Provider), 14, core.Text{Content: modelName(m), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 13.5}, StyleFunc: ui.Colored(colors.Text)}),
						core.Text{Content: modelPathLabel(m), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					}},
					core.Show{When: func() bool { return m.Reasoning }, Then: func(*core.Scope) core.Node {
						return ui.Icon(lucide.Brain, 12, colors.Faint)
					}},
				}}
		}
		// Grouped by supplier, suppliers alphabetically: without the desktop's
		// own order the phone cannot tell which one the user pinned.
		groups := map[string][]remotewire.Model{}
		var order []string
		for _, m := range opts.Models {
			if !match(m) {
				continue
			}
			if _, ok := groups[m.Provider]; !ok {
				order = append(order, m.Provider)
			}
			groups[m.Provider] = append(groups[m.Provider], m)
		}
		if len(order) == 0 {
			return core.View{Style: core.Style{Padding: core.Symmetric(14, 8)}, Children: []core.Node{
				core.Text{Content: apptext.T("没有匹配的模型"), MaxLines: 2,
					Style: core.Style{FontSize: 12, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Faint)}}}
		}
		sort.SliceStable(order, func(i, j int) bool {
			// A supplier with no name sorts first: it is the local pi.
			if (order[i] == "") != (order[j] == "") {
				return order[i] == ""
			}
			return strings.ToLower(order[i]) < strings.ToLower(order[j])
		})
		var out []core.Node
		for _, p := range order {
			head := []core.Node{ui.Text(supplierLabel(p), 10, ui.Medium, colors.Faint)}
			if mark := brands.Mark(p, 12, colors.Muted); mark != nil {
				head = append([]core.Node{mark}, head...)
			}
			out = append(out, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6,
				Padding: core.Edges{Top: 10, Right: 8, Bottom: 4, Left: 8}}, Children: head})
			for _, m := range groups[p] {
				out = append(out, row(m))
			}
		}
		return core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: out}
	})
	return core.View{Style: core.Style{Gap: 6}, Children: append(sections,
		a.scrollStashFor("optionsSheet:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(320)}, Children: []core.Node{rows}}))}
}

// supplierLabel names a model's supplier, the wordless group last.
func supplierLabel(provider string) string {
	if strings.TrimSpace(provider) == "" {
		return apptext.T("本机")
	}
	return provider
}

// modelName is a model's name without the routing suffix pi appends.
func modelName(m remotewire.Model) string {
	name := m.Name
	if name == "" {
		name = m.ID
	}
	if i := strings.Index(name, " · "); i > 0 {
		name = name[:i]
	}
	return name
}

// modelPathLabel is where a model comes from, so two models with one name
// stay apart.
func modelPathLabel(m remotewire.Model) string {
	if m.Provider == "" {
		return m.ID
	}
	return m.Provider + " · " + m.ID
}

// backendSection lists where the session can run: pi, or an ACP agent the
// desktop has installed. The first message fixes the choice.
func (a *mobileApp) backendSection(cx *core.Scope, opts remotewire.Options) core.Node {
	colors := ui.ColorsOf(cx)
	rows := make([]core.Node, 0, len(opts.Backends))
	for _, b := range opts.Backends {
		backend := b
		on := backend.ID == opts.Backend
		disabled := opts.BackendLocked && !on
		rows = append(rows, core.View{OnPress: func(core.PressEvent) {
			if opts.BackendLocked || on {
				return
			}
			a.chooseBackend(backend)
		}, Role: core.RoleButton, Label: backend.Name, TestID: "mobile-backend-row",
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(40),
					Padding: core.Symmetric(0, 8), CornerRadius: 7, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				if disabled {
					st.Disabled = ui.Dimmed()
				}
				return st
			},
			Children: []core.Node{
				// The agent's mark says which one this backend starts; pi and a
				// preset the set does not know keep their names alone.
				brands.Mark(strings.TrimPrefix(backend.ID, "acp:"), 15, colors.Muted),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
					core.Text{Content: backend.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 13.5}, StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return backend.Detail != "" }, Then: func(*core.Scope) core.Node {
						return core.Text{Content: backend.Detail, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
					}},
				}},
				core.Show{When: func() bool { return on }, Then: func(*core.Scope) core.Node {
					return ui.Icon(lucide.Check, 14, colors.Text)
				}},
			}})
	}
	head := []core.Node{ui.Text(apptext.T("后端"), 11, ui.Medium, colors.Faint)}
	if opts.BackendLocked {
		head = append(head, core.Text{Content: apptext.T("已经开始了：换后端要新建会话"), MaxLines: 2,
			Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)})
	}
	return core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
		core.View{Style: core.Style{Gap: 1}, Children: head},
		core.View{Style: core.Style{Gap: 1}, Children: rows},
	}}
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
