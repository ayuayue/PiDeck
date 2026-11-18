//go:build !js && !android && !ios

package workbench

// The vision bridge's dialog: an image, a question, and a vision model
// that turns the picture into text a text-only model can read.

import (
	"os"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// openVisionDialog shows the bridge with the last choices.
func (a *app) openVisionDialog() {
	providers := readProviderConfigs()
	id := a.cfg.VisionProvider
	known := false
	for _, cfg := range providers {
		if cfg.ID == id {
			known = true
		}
	}
	if !known && len(providers) > 0 {
		id = providers[0].ID
	}
	a.visionProvider.Set(id)
	a.visionModel.Set(a.cfg.VisionModel)
	a.visionPath.Set("")
	a.visionQuestion.Set(defaultVisionQuestion)
	a.visionErr.Set("")
	a.visionText.Set("")
	a.visionBusy.Set(false)
	a.visionOpen.Set(true)
}

// visionProviderConfig finds the chosen provider.
func (a *app) visionProviderConfig() *providerConfig {
	id := a.visionProvider.GetUntracked()
	for _, cfg := range readProviderConfigs() {
		if cfg.ID == id {
			cp := cfg
			return &cp
		}
	}
	return nil
}

// runVision reads the picture and asks the vision model about it.
func (a *app) runVision() {
	if a.visionBusy.GetUntracked() {
		return
	}
	cfg := a.visionProviderConfig()
	if cfg == nil {
		a.visionErr.Set("先选一个供应商；在设置 → 模型与认证里配置。")
		return
	}
	path := strings.TrimSpace(a.visionPath.GetUntracked())
	if path == "" {
		a.visionErr.Set("先选一张图片。")
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		a.visionErr.Set("读不了这张图片：" + err.Error())
		return
	}
	if len(raw) > 20<<20 {
		a.visionErr.Set("图片太大，换一张 20 MB 以内的。")
		return
	}
	model := strings.TrimSpace(a.visionModel.GetUntracked())
	question := strings.TrimSpace(a.visionQuestion.GetUntracked())
	a.visionBusy.Set(true)
	a.visionErr.Set("")
	a.visionText.Set("")
	go func() {
		text, err := describeImage(*cfg, model, question, raw, imageMimeOf(raw))
		a.cx.Post(func() {
			a.visionBusy.Set(false)
			if err != nil {
				a.visionErr.Set(err.Error())
				return
			}
			a.visionText.Set(text)
			a.cfg.VisionProvider, a.cfg.VisionModel = cfg.ID, model
			if a.st != nil {
				a.st.edit(func(c *config) { c.VisionProvider, c.VisionModel = cfg.ID, model })
			}
		})
	}()
}

// insertVisionText puts the description in the composer, after what is
// already drafted.
func (a *app) insertVisionText() {
	s := a.active()
	text := strings.TrimSpace(a.visionText.GetUntracked())
	if text == "" {
		return
	}
	if s == nil {
		a.toast(ui.ToastInfo, "先开一个会话", "描述会插到输入框里。")
		return
	}
	draft := strings.TrimSpace(s.draft.GetUntracked())
	if draft != "" {
		draft += "\n\n"
	}
	s.draft.Set(draft + text)
	a.visionOpen.Set(false)
	a.toast(ui.ToastSuccess, "已插入输入框", "可以随下一条消息发出去。")
}

// visionDialog turns an image into a description.
func (a *app) visionDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		providers := readProviderConfigs()
		var providerChoices []choice[string]
		for _, cfg := range providers {
			providerChoices = append(providerChoices, choice[string]{Value: cfg.ID, Label: cfg.ID})
		}
		busy := a.visionBusy.Get()
		var body []core.Node
		if len(providerChoices) > 0 {
			body = append(body, core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text(apptext.T("供应商"), 10.5, ui.Medium, colors.Muted),
				choiceChips(providerChoices, func() string { return a.visionProvider.Get() }, func(v string) { a.visionProvider.Set(v) }),
			}})
		} else {
			body = append(body, core.Text{Content: apptext.T("还没有供应商。先在 设置 → 模型与认证 里配置一个支持图片输入的供应商。"),
				Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Warn)})
		}
		body = append(body,
			core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text(apptext.T("图片"), 10.5, ui.Medium, colors.Muted),
				core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.Input{Value: a.visionPath.Get, OnChange: a.visionPath.Set, Placeholder: apptext.T("图片路径，或从项目里选"),
							Label: apptext.T("图片路径"), TestID: "vision-path",
							Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), FontSize: 11.5, FontFamily: viewkit.MonoFont(), Color: colors.Text(),
								Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 7}},
					}},
					ui.Button{Text: apptext.T("选择…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "vision-pick",
						OnPress: func() { a.pickNative("image") }},
				}},
			}},
			core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text(apptext.T("问题"), 10.5, ui.Medium, colors.Muted),
				core.Input{Value: a.visionQuestion.Get, OnChange: a.visionQuestion.Set, Multiline: true, AutoFocus: true,
					Placeholder: defaultVisionQuestion, Label: apptext.T("问题"), TestID: "vision-question",
					Style: core.Style{MinHeight: core.Pt(58), MaxHeight: core.Pt(120), Padding: core.Symmetric(8, 10), FontSize: 12.5, Color: colors.Text()},
					StyleFunc: func() core.Style {
						return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 8,
							PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
					}},
			}},
			core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text(apptext.T("视觉模型"), 10.5, ui.Medium, colors.Muted),
				core.Input{Value: a.visionModel.Get, OnChange: a.visionModel.Set, Placeholder: apptext.T("支持图片输入的模型名，如 gpt-4o-mini"),
					Label: apptext.T("视觉模型"), TestID: "vision-model",
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), FontSize: 12, FontFamily: viewkit.MonoFont(), Color: colors.Text(),
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 7}},
			}},
		)
		switch {
		case busy:
			body = append(body, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(6, 0)}, Children: []core.Node{
				ui.Spinner{Size: 14}, ui.Text(apptext.T("正在读图…"), 11.5, ui.Regular, colors.Muted)}})
		case a.visionErr.Get() != "":
			body = append(body, core.Text{Content: a.visionErr.Get(), MaxLines: 4, Style: core.Style{FontSize: 11, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Danger)})
		case a.visionText.Get() != "":
			body = append(body, core.View{TestID: "vision-result", Style: core.Style{Gap: 4}, Children: []core.Node{
				ui.Text(apptext.T("描述"), 10.5, ui.Medium, colors.Muted),
				core.Scroll{Style: core.Style{MaxHeight: core.Pt(220)}, Children: []core.Node{
					core.Text{Content: a.visionText.Get(), Selectable: core.SelectableOn,
						Style: core.Style{FontSize: 12, LineHeight: 18, Color: colors.Text()}},
				}},
			}})
		}
		footer := []core.Node{
			ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.visionOpen.Set(false) }},
		}
		if a.visionText.Get() != "" && !busy {
			footer = append(footer,
				ui.Button{Text: apptext.T("复制"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "vision-copy",
					OnPress: func() { a.copyText(a.visionText.GetUntracked(), "描述") }},
				ui.Button{Text: apptext.T("插入输入框"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "vision-insert", OnPress: a.insertVisionText})
		} else {
			footer = append(footer, ui.Button{Text: apptext.T("描述"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "vision-run",
				Disabled: func() bool { return a.visionBusy.Get() || len(providerChoices) == 0 }, OnPress: a.runVision})
		}
		return ui.Dialog{
			Open:         a.visionOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.visionOpen.Set(open) },
			Title:        apptext.T("描述图片"),
			TestID:       "vision-dialog",
			Style:        core.Style{Width: core.Pt(560), MaxHeight: core.Pt(640)},
			Children: []core.Node{core.Scroll{Style: core.Style{MaxHeight: core.Pt(500)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 12}, Children: body}}}},
			Footer: footer,
		}
	})
}
