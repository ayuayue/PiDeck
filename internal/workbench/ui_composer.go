//go:build !js && !android && !ios

package workbench

// The composer's controls: the backend it talks to, the mode chip, the
// model and thinking pickers, the picture settings, the delivery menu and
// the queue above the card. Each is drawn from the app's own pieces, so one
// tooltip style and one row height holds across the row.

import (
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// composerChip is a small control in the composer's bottom row: an icon, a
// label and an optional caret, 26 points tall, with a card hint.
type composerChip struct {
	Icon func() *core.SVG
	// Label is the chip's words; Name is what assistive technology reads
	// for a chip of a glyph alone.
	Label   func() string
	Name    string
	TestID  string
	Caret   bool
	OnPress func()
}

// node draws the chip where the row lays it out.
func (c composerChip) node() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var children []core.Node
		if c.Icon != nil {
			children = append(children, ui.Icon(c.Icon, 12.5, colors.Muted))
		}
		if c.Label != nil {
			children = append(children, core.Text{ContentFunc: c.Label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 11.5, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Text)})
		}
		if c.Caret {
			children = append(children, ui.Icon(lucide.ChevronDown, 9.5, colors.Faint))
		}
		label := c.Name
		if c.Label != nil && c.Label() != "" {
			label = c.Label()
		}
		return core.View{
			OnPress: func(core.PressEvent) {
				if c.OnPress != nil {
					c.OnPress()
				}
			},
			Role: core.RoleButton, Label: label, TestID: c.TestID,
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), FlexShrink: 0,
					Padding: core.Symmetric(0, 7), CornerRadius: 7, Transition: viewkit.PressMotion,
					Hover:        &core.Style{Background: colors.Hover()},
					FocusVisible: ui.FocusRing(cx, 2)}
			},
			Children: []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5,
				MinWidth: core.Pt(0)}, Children: children}},
		}
	})
}

// composerRow is one row of the app's menu card, for the composer's
// popovers: a glyph, a title over a detail, and a check on the choice.
func composerRow(cx *core.Scope, icon func() *core.SVG, title, detail string, checked, disabled bool, onPress func()) core.View {
	colors := ui.ColorsOf(cx)
	var children []core.Node
	if icon != nil {
		children = append(children, ui.Icon(icon, 13, colors.Muted))
	}
	body := core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
		core.Text{Content: title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail, Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
	}}
	if detail != "" {
		body.Children = append(body.Children, core.Text{Content: detail, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
	}
	children = append(children, body)
	if checked {
		children = append(children, ui.Icon(lucide.Check, 12, colors.Accent))
	}
	return core.View{
		OnPress: func(core.PressEvent) {
			if !disabled && onPress != nil {
				onPress()
			}
		},
		Disabled: func() bool { return disabled },
		Role:     core.RoleButton, Label: title,
		Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(30),
			Padding: core.Symmetric(2, 8), CornerRadius: 7, Disabled: ui.Dimmed()},
		StyleFunc: func() core.Style {
			if disabled {
				return core.Style{}
			}
			return core.Style{Hover: &core.Style{Background: colors.Hover()}}
		},
		Children: children,
	}
}

// composerPanelTitle heads a group of rows.
func composerPanelTitle(cx *core.Scope, text string) core.Node {
	colors := ui.ColorsOf(cx)
	return core.Text{Content: text, MaxLines: 1,
		Style:     core.Style{FontSize: 10, LetterSpacing: 0.4, Padding: core.Edges{Top: 6, Left: 8, Bottom: 2}},
		StyleFunc: ui.Colored(colors.Faint)}
}

// composerDivider splits groups of rows.
func composerDivider(cx *core.Scope) core.Node {
	return core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Symmetric(4, 0)}, StyleFunc: ui.Filled(ui.ColorsOf(cx).Line)}
}

// composerBackendPicker names where the session runs and lets a blank one
// change it: its first message fixes the backend its transcript lives in.
func (a *app) composerBackendPicker(s *session) core.Node {
	label := func() string {
		if backendOf(s) == "acp" {
			if p := a.acpPresetByID(s.acpPreset); p != nil {
				return p.Name
			}
			return "ACP"
		}
		return "pi"
	}
	icon := func() *core.SVG {
		if backendOf(s) == "acp" {
			return lucide.Plug()
		}
		return lucide.Terminal()
	}
	trigger := core.Dynamic(func(cx *core.Scope) core.Node {
		s.uiSeq.Get()
		return hintOf(func() string {
			if a.backendLocked(s) {
				return apptext.T("后端 · %s（会话开始后不能再换）", label())
			}
			return apptext.T("后端 · %s（点一下换）", label())
		}, composerChip{Icon: icon, Label: label, Caret: true, TestID: "backend-picker", OnPress: func() {
			s.backendOpen.Update(func(v bool) bool { return !v })
		}}.node())
	})
	return a.popoverCard(s.backendOpen, core.PlaceTop, core.AlignStart, 268, trigger, func(cx *core.Scope) core.Node {
		locked := a.backendLocked(s)
		rows := []core.Node{
			composerPanelTitle(cx, apptext.T("后端")),
			composerRow(cx, lucide.Terminal, "pi", apptext.T("本机 pi 会话"), backendOf(s) != "acp", locked, func() { a.setBackend(s, "pi", "") }),
			composerDivider(cx),
			composerPanelTitle(cx, apptext.T("ACP 智能体")),
		}
		var agents []core.Node
		for _, p := range a.acpPresetList() {
			preset := p
			agents = append(agents, composerRow(cx, lucide.Plug, preset.Name, strings.TrimSpace(preset.Command+" "+strings.Join(preset.Args, " ")),
				backendOf(s) == "acp" && s.acpPreset == preset.ID, locked, func() { a.setBackend(s, "acp", preset.ID) }))
		}
		rows = append(rows, core.Scroll{Style: core.Style{MaxHeight: core.Pt(220), MinWidth: core.Pt(0)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: agents}}})
		rows = append(rows, composerDivider(cx))
		rows = append(rows, composerRow(cx, lucide.Mic, apptext.T("转写录音…"), apptext.T("导入 WAV 录音到输入框"), false, a.voiceCapture.state.Get() != "", func() {
			s.modeOpen.Set(false)
			a.pickVoiceRecording(s)
		}))
		note := apptext.T("发出第一条消息前可以换后端。")
		if locked {
			note = apptext.T("这个会话已经开始了：新建会话才能换后端。")
		}
		rows = append(rows, core.Text{Content: note, MaxLines: 2,
			Style: core.Style{FontSize: 10.5, LineHeight: 15, Padding: core.Symmetric(2, 8)}, StyleFunc: ui.Colored(ui.ColorsOf(cx).Faint)})
		return core.View{Style: core.Style{Gap: 1}, Children: rows}
	}, "backend-menu")
}

// composerAddMenu holds what the composer can be given: a picture, and the
// mode the next prompt asks for.
func (a *app) composerAddMenu(s *session) core.Node {
	trigger := hintOf(func() string { return apptext.T("添加：图片、模式") }, a.pressIcon(lucide.Plus, apptext.T("添加"), 26, 14, nil, func() {
		s.modeOpen.Update(func(v bool) bool { return !v })
	}, "composer-add"))
	return a.popoverCard(s.modeOpen, core.PlaceTop, core.AlignStart, 248, trigger, func(cx *core.Scope) core.Node {
		mode := modeOf(s)
		toggle := func(want string) {
			if mode == want {
				a.setAgentMode(s, modeNormal)
				return
			}
			a.setAgentMode(s, want)
		}
		rows := []core.Node{
			core.View{TestID: "attach-image", Children: []core.Node{
				composerRow(cx, lucide.ImagePlus, apptext.T("附加图片…"), apptext.T("从剪贴板读取"), false, false, func() {
					s.modeOpen.Set(false)
					a.pasteImage(s)
				}),
			}},
			composerDivider(cx),
			composerPanelTitle(cx, apptext.T("下一轮")),
			composerRow(cx, lucide.ClipboardList, apptext.T("计划模式"), apptext.T("先给计划，确认后再动手"), mode == modePlan, false, func() { toggle(modePlan) }),
			composerRow(cx, lucide.Target, apptext.T("目标模式"), apptext.T("没完成就自己继续，直到完成或停下"), mode == modeGoal, false, func() { toggle(modeGoal) }),
			composerRow(cx, lucide.Image, apptext.T("生图模式"), apptext.T("把这句话画成一张图"), mode == modeImage, backendOf(s) == "acp", func() { toggle(modeImage) }),
		}
		return core.View{Style: core.Style{Gap: 1}, Children: rows}
	}, "composer-add-menu")
}

// composerModeChip is the mode in force and its way out: a goal's label
// pauses or resumes it, the × returns to normal.
func (a *app) composerModeChip(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		mode := s.agentMode.Get()
		if mode == "" {
			mode = modeNormal
		}
		if mode == modeNormal {
			return nil
		}
		colors := ui.ColorsOf(cx)
		var icon func() *core.SVG
		var label, hint string
		switch mode {
		case modeGoal:
			icon = lucide.Target
			switch {
			case s.goalPaused.Get():
				label, hint = apptext.T("目标 · 已暂停"), apptext.T("目标已暂停 · 点一下继续，× 退出")
			case s.goalRounds > 1:
				label, hint = apptext.T("目标 · 第 %d 轮", s.goalRounds), apptext.T("目标模式 · 点一下暂停，× 退出")
			default:
				label, hint = apptext.T("目标"), apptext.T("目标模式 · 点一下暂停，× 退出")
			}
		case modeImage:
			icon, label, hint = lucide.Image, apptext.T("生图"), apptext.T("生图模式 · 点一下看设置，× 退出")
		default:
			icon, label, hint = lucide.ClipboardList, apptext.T("计划"), apptext.T("计划模式 · × 退出")
		}
		press := func() {
			switch mode {
			case modeGoal:
				if s.goalPaused.GetUntracked() {
					a.resumeGoal(s)
					return
				}
				a.pauseGoal(s)
			case modeImage:
				s.imageOpen2.Update(func(v bool) bool { return !v })
			}
		}
		return hintOf(func() string { return hint }, core.View{
			TestID: "agent-mode-chip",
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2, Height: core.Pt(26), FlexShrink: 0,
				Padding: core.Edges{Left: 2, Right: 2}, CornerRadius: 7, Background: ui.Alpha(colors.Accent(), 0.13),
				BorderWidth: 1, BorderColor: ui.Alpha(colors.Accent(), 0.34)},
			Children: []core.Node{
				core.View{OnPress: func(core.PressEvent) { press() },
					Role: core.RoleButton, Label: label, TestID: "agent-mode-label",
					Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(24),
						Padding: core.Symmetric(0, 5), CornerRadius: 6, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: ui.Alpha(colors.Accent(), 0.16)}},
					Children: []core.Node{
						core.Dynamic(func(cx *core.Scope) core.Node {
							if mode == modeImage && a.aiBusy.Get() == "image" {
								return ui.Spinner{Size: 11}
							}
							return ui.Icon(icon, 12, ui.ColorsOf(cx).Accent)
						}),
						core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style:     core.Style{FontSize: 11.5, MinWidth: core.Pt(0), FlexShrink: 1, FontWeight: ui.Medium},
							StyleFunc: ui.Colored(colors.Text)},
					}},
				core.View{OnPress: func(core.PressEvent) { a.setAgentMode(s, modeNormal) },
					Role: core.RoleButton, Label: apptext.T("退出模式"), TestID: "agent-mode-exit",
					Style: core.Style{Width: core.Pt(20), Height: core.Pt(20), CornerRadius: 5,
						AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
						Hover: &core.Style{Background: colors.Hover()}},
					Children: []core.Node{ui.Icon(lucide.X, 10, colors.Muted)}},
			},
		})
	})
}

// effortPicker is the reasoning level: the chat kit's slider, whose levels
// are the ones the current model accepts. It is rebuilt when the model
// changes, because each model has its own levels.
func (a *app) effortPicker(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		levels := s.levels.Get()
		if len(levels) == 0 {
			level := s.thinking.Get()
			if level == "" {
				return nil
			}
			// The file records the selection, not the model's supported levels.
			colors := ui.ColorsOf(cx)
			return core.View{TestID: "effort-picker", Label: apptext.T("思考等级 · %s", levelLabel(level)),
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5,
					Height: core.Pt(26), Padding: core.Symmetric(0, 7)},
				Children: []core.Node{
					ui.Icon(lucide.Brain, 12, colors.Muted),
					core.Text{Content: levelLabel(level), MaxLines: 1,
						Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
				}}
		}
		options := make([]chat.Option, 0, len(levels))
		for _, l := range levels {
			options = append(options, chat.Option{ID: l, Label: levelLabel(l)})
		}
		return chat.EffortPicker{
			Label:  apptext.T("思考"),
			Icon:   lucide.Brain,
			Levels: options,
			Selected: func() string {
				return s.thinking.Get()
			},
			OnChange: func(id string) { a.applyThinking(s, id, true) },
			Off:      true,
			Tooltip: func() string {
				if len(levels) == 1 {
					return apptext.T("思考等级 · %s（该模型只有这一档）", levelLabel(s.thinking.Get()))
				}
				return apptext.T("思考等级 · %s", levelLabel(s.thinking.Get()))
			},
			TestID: "effort-picker",
		}
	})
}

// composerImageOptions is picture mode's settings: the provider, the model
// name and the size. The values live in signals, so typing a model name
// never rebuilds the field it is typed into.
func (a *app) composerImageOptions(s *session) core.Node {
	provider := func() string {
		if id := a.imageProvider.Get(); id != "" {
			return id
		}
		return a.imageProviderForComposer()
	}
	model := func() string { return strings.TrimSpace(a.imageModel.Get()) }
	label := func() string {
		if m := model(); m != "" {
			return m
		}
		return apptext.T("生图设置")
	}
	trigger := core.Dynamic(func(*core.Scope) core.Node {
		return hintOf(func() string {
			return apptext.T("生图设置 · %s / %s", firstNonEmpty(provider(), apptext.T("未选供应商")), firstNonEmpty(model(), apptext.T("未选模型")))
		}, composerChip{Icon: lucide.Image, Label: label, Caret: true, TestID: "image-options",
			OnPress: func() {
				if a.imageModel.GetUntracked() == "" {
					a.imageModel.Set(a.cfg.ImageModel)
					a.imageSize.Set(firstNonEmpty(a.cfg.ImageSize, "1024x1024"))
					a.imageProvider.Set(a.imageProviderForComposer())
				}
				s.imageOpen2.Update(func(v bool) bool { return !v })
			}}.node())
	})
	return a.popoverCard(s.imageOpen2, core.PlaceTop, core.AlignStart, 300, trigger, func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		providers := readProviderConfigs()
		rows := []core.Node{composerPanelTitle(cx, apptext.T("供应商"))}
		for _, cfg := range providers {
			p := cfg
			rows = append(rows, composerRow(cx, nil, p.ID, shortPath(p.BaseURL, 44), p.ID == provider(), false, func() {
				a.imageProvider.Set(p.ID)
				a.saveImageChoice(p.ID, a.imageModel.GetUntracked(), a.imageSize.GetUntracked())
			}))
		}
		if len(providers) == 0 {
			rows = append(rows, core.Text{Content: apptext.T("还没有配置供应商"), MaxLines: 1,
				Style: core.Style{FontSize: 11, Padding: core.All(8)}, StyleFunc: ui.Colored(colors.Faint)})
		}
		rows = append(rows, composerDivider(cx), composerPanelTitle(cx, apptext.T("模型")))
		rows = append(rows, core.View{StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(30), Padding: core.Symmetric(0, 8),
				CornerRadius: 6, BorderWidth: 1, BorderColor: colors.FieldBorder(), Background: colors.Field()}
		}, Children: []core.Node{
			core.Input{Value: a.imageModel.Get,
				OnChange: func(v string) {
					a.imageModel.Set(v)
					a.saveImageChoice(provider(), v, a.imageSize.GetUntracked())
				},
				Placeholder: "gpt-image-1", Label: apptext.T("生图模型"), TestID: "image-model",
				Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 12},
				StyleFunc: func() core.Style {
					return core.Style{Color: colors.Text(), PlaceholderColor: colors.Faint(), CaretColor: colors.Text(),
						SelectionColor: colors.Now().Selection}
				}},
		}})
		rows = append(rows, composerPanelTitle(cx, apptext.T("尺寸")))
		for _, size := range []string{"1024x1024", "1024x1536", "1536x1024", "512x512"} {
			sz := size
			rows = append(rows, composerRow(cx, nil, sz, "", a.imageSize.Get() == sz, false, func() {
				a.imageSize.Set(sz)
				a.saveImageChoice(provider(), a.imageModel.GetUntracked(), sz)
			}))
		}
		rows = append(rows, composerDivider(cx), ui.Button{Text: apptext.T("更多设置…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
			OnPress: func() {
				s.imageOpen2.Set(false)
				a.openImageDialog()
				a.imagePrompt.Set(s.draft.GetUntracked())
			}})
		return core.View{Style: core.Style{Gap: 1}, Children: rows}
	}, "image-options-menu")
}

// saveImageChoice remembers what the composer draws pictures with.
func (a *app) saveImageChoice(provider, model, size string) {
	a.cfg.ImageProvider, a.cfg.ImageModel = provider, model
	if strings.TrimSpace(size) != "" {
		a.cfg.ImageSize = size
	}
	if a.st != nil {
		a.st.edit(func(c *config) {
			c.ImageProvider, c.ImageModel = provider, model
			if strings.TrimSpace(size) != "" {
				c.ImageSize = size
			}
		})
	}
}

// composerToolsMenu groups the two draft-only AI actions behind one
// distinct control, keeping their neighboring icons from competing.
func (a *app) composerToolsMenu(s *session, open *core.Signal[bool]) core.Node {
	trigger := hintOf(func() string { return apptext.T("工具") }, composerChip{Icon: lucide.Ellipsis, Name: apptext.T("工具"),
		TestID: "composer-tools", OnPress: func() { open.Update(func(v bool) bool { return !v }) }}.node())
	return a.popoverCard(open, core.PlaceTop, core.AlignEnd, 280, trigger, func(cx *core.Scope) core.Node {
		a.toolRev.Get()
		busy := a.aiBusy.Get() != ""
		empty := strings.TrimSpace(s.draft.Get()) == ""
		toolRow := func(tool, testID string, icon func() *core.SVG, title, detail string, run func()) core.Node {
			missing := strings.TrimSpace(a.cfg.ToolModels[tool].Provider) == ""
			switch {
			case busy:
				detail = apptext.T("工具正在运行，请稍候")
			case missing:
				detail = apptext.T("未配置模型，点击前往设置")
			case empty:
				detail = apptext.T("先输入草稿")
			}
			row := composerRow(cx, icon, title, detail, false, busy || (empty && !missing), func() {
				open.Set(false)
				if missing {
					a.openPane(paneSettings)
					a.openSettingsSection("models")
					return
				}
				run()
			})
			row.TestID = testID
			return row
		}
		template := composerRow(cx, lucide.Settings2, apptext.T("增强模板…"), "", false, false, func() {
			open.Set(false)
			a.openPromptTemplate()
		})
		template.TestID = "prompt-template-open"
		return core.View{Style: core.Style{Gap: 1}, Children: []core.Node{
			composerPanelTitle(cx, apptext.T("工具")),
			toolRow("prompt", "prompt-enhance", lucide.WandSparkles, apptext.T("增强提示词"),
				apptext.T("把输入框里的草稿改写得更清楚、更具体。"), func() { a.enhanceDraft(s) }),
			toolRow("predict", "prompt-predict", lucide.TextCursorInput, apptext.T("续写"),
				apptext.T("在输入框里续写草稿的下一句。"), func() { a.predictDraft(s) }),
			composerDivider(cx), template,
		}}
	}, "composer-tools-menu")
}

// sendMenu chooses how the next message joins a running turn, or starts it
// in a session of its own.
func (a *app) sendMenu(s *session) core.Node {
	hint := func() string {
		if delivery(s) == deliveryFollowUp {
			return apptext.T("发送方式 · 本轮结束后发送")
		}
		return apptext.T("发送方式 · 下一次调用前加入本轮")
	}
	trigger := hintOf(hint, composerChip{Icon: lucide.ChevronDown, Name: apptext.T("发送方式"), TestID: "send-behavior",
		OnPress: func() { s.sendOpen.Update(func(v bool) bool { return !v }) }}.node())
	return a.popoverCard(s.sendOpen, core.PlaceTop, core.AlignEnd, 288, trigger, func(cx *core.Scope) core.Node {
		held := s.sendMode.Get() == deliveryFollowUp
		acp := backendOf(s) == "acp"
		sendNow := strings.TrimSpace(s.draft.Get()) != "" || len(s.images.Get()) > 0
		canParallel := strings.TrimSpace(s.draft.Get()) != "" && len(s.images.Get()) == 0
		rows := []core.Node{
			composerPanelTitle(cx, apptext.T("运行中发送时")),
			composerRow(cx, lucide.CornerUpRight, apptext.T("加入当前回合"), apptext.T("下一次调用前生效，不打断它能做的事"),
				!acp && !held, acp, func() { s.sendMode.Set(""); s.sendOpen.Set(false) }),
			composerRow(cx, lucide.ListOrdered, apptext.T("排队到下一轮"), apptext.T("这一轮结束后再发"),
				held, false, func() { s.sendMode.Set(deliveryFollowUp); s.sendOpen.Set(false) }),
			composerDivider(cx),
			composerPanelTitle(cx, apptext.T("现在发送")),
			composerRow(cx, lucide.ListOrdered, apptext.T("排队这句"), apptext.T("现在放进队尾，等本轮结束"), false, !sendNow, func() {
				s.sendOpen.Set(false)
				a.sendDraft(s, deliveryFollowUp)
			}),
			composerRow(cx, lucide.Split, apptext.T("并行发送"), apptext.T("开一个独立会话处理，不打断这一轮"), false, !canParallel, func() {
				s.sendOpen.Set(false)
				a.sendDraft(s, deliveryParallel)
			}),
		}
		return core.View{Style: core.Style{Gap: 1}, Children: rows}
	}, "send-behavior-menu")
}

// contextMeterNode is the ring beside the send button, and the panel it
// opens: the same facts PiDeck's gauge shows, in the same place.
func (a *app) contextMeterNode(s *session) core.Node {
	trigger := hintOf(a.usageHint(s), a.contextRing(s, s.usageOpen))
	return a.popoverCard(s.usageOpen, core.PlaceTop, core.AlignEnd, contextPanelWidth, trigger,
		func(cx *core.Scope) core.Node {
			return a.contextPanel(s, func() { s.usageOpen.Set(false) })
		}, "usage-popover")
}
