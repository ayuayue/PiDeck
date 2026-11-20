//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// composerAccessory leads the control row with the add menu and the
// active prompt mode.
func (a *app) composerAccessory(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		return core.Dynamic(func(cx *core.Scope) core.Node {
			// Follow the mode and the agent's own changes, which live outside
			// signals.
			s.agentMode.Get()
			var parts []core.Node
			parts = append(parts, a.composerAddMenu(s))
			if chip := a.composerModeChip(s); chip != nil {
				parts = append(parts, chip)
			}
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, MinWidth: core.Pt(0),
				FlexShrink: 1, Overflow: core.Hidden}, Children: parts}
		})
	}
}

// composerModelControls keeps the active model and its thinking level
// together in the center of the input controls.
func (a *app) composerModelControls(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		return core.Dynamic(func(cx *core.Scope) core.Node {
			s.agentMode.Get()
			s.uiSeq.Get()
			var controls []core.Node
			switch {
			case modeOn(s, modeImage):
				controls = append(controls, a.composerImageOptions(s))
			case backendOf(s) == "acp":
				controls = append(controls, a.acpBadge(s))
			default:
				controls = append(controls, hintOf(func() string {
					if m := s.model.Get(); m.ID != "" {
						return apptext.T("模型 · %s", modelLabel(m))
					}
					return apptext.T("选择模型")
				}, a.modelMenu(s, s.modelOpen)))
				controls = append(controls, a.effortPicker(s))
			}
			return core.View{TestID: "composer-model-controls",
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, FlexShrink: 0, MinWidth: core.Pt(0)}, Children: controls}
		})
	}
}

// enhanceDraft asks the prompt tool to rewrite the draft.
func (a *app) enhanceDraft(s *session) {
	if a.aiBusy.GetUntracked() != "" {
		return
	}
	draft := s.draft.GetUntracked()
	if strings.TrimSpace(draft) == "" {
		return
	}
	if !a.toolConfigured("prompt") {
		a.toast(ui.ToastInfo, apptext.T("还没有配置提示词增强的模型"), apptext.T("到 设置 → 模型 → 工具模型 里选供应商和模型。"))
		return
	}
	a.aiBusy.Set("prompt")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		text, err := a.completeDraftTool(ctx, "prompt", draft)
		a.cx.Post(func() {
			a.aiBusy.Set("")
			if err != nil {
				a.toast(ui.ToastError, apptext.T("提示词增强失败"), viewkit.FirstLine(err.Error(), 160))
				return
			}
			text = strings.TrimSpace(cleanLLMText(text))
			if text == "" {
				a.toast(ui.ToastWarning, "模型没有返回文字", "当前草稿已保留，请重试。")
				return
			}
			a.offerDraftChange(s, draft, text)
		})
	}()
}

// predictDraft asks the prediction tool for the draft's next sentence.
func (a *app) predictDraft(s *session) {
	if a.aiBusy.GetUntracked() != "" {
		return
	}
	draft := s.draft.GetUntracked()
	if strings.TrimSpace(draft) == "" {
		return
	}
	if !a.toolConfigured("predict") {
		a.toast(ui.ToastInfo, apptext.T("还没有配置输入预测的模型"), apptext.T("到 设置 → 模型 → 工具模型 里选供应商和模型。"))
		return
	}
	a.aiBusy.Set("predict")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		text, err := a.completeDraftTool(ctx, "predict", draft)
		a.cx.Post(func() {
			a.aiBusy.Set("")
			if err != nil {
				a.toast(ui.ToastError, apptext.T("输入预测失败"), viewkit.FirstLine(err.Error(), 160))
				return
			}
			text = strings.TrimSpace(cleanLLMText(text))
			if text == "" {
				return
			}
			a.offerDraftChange(s, draft, strings.TrimRight(draft, " \n")+" "+text)
		})
	}()
}

// composerTrailing holds the text tools, the context gauge and the way
// messages are sent.
func (a *app) composerTrailing(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		return core.Dynamic(func(cx *core.Scope) core.Node {
			s.sendMode.Get()
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2}, Children: []core.Node{
				a.composerToolsMenu(s, s.toolsOpen),
				a.voiceCaptureButton(s),
				a.contextMeterNode(s),
				a.sendMenu(s),
			}}
		})
	}
}

// contextValue describes the context window's use.
func (a *app) contextValue(s *session) string {
	st := s.stats.Get()
	if st.ContextWindow > 0 {
		return fmt.Sprintf("%s / %s (%.0f%%)", viewkit.Tokens(st.ContextTokens), viewkit.Tokens(st.ContextWindow), st.ContextPercent)
	}
	m := s.model.Get()
	u := s.usage.Get()
	if m.ContextWindow > 0 && u.Total > 0 {
		return fmt.Sprintf("%s / %s", viewkit.Tokens(u.Total), viewkit.Tokens(m.ContextWindow))
	}
	return apptext.T("未测量")
}

// contextFraction is how full the context is, negative when unknown.
func (a *app) contextFraction(s *session) float64 {
	st := s.stats.Get()
	if st.ContextWindow > 0 {
		return min(1, float64(st.ContextTokens)/float64(st.ContextWindow))
	}
	m := s.model.Get()
	u := s.usage.Get()
	if m.ContextWindow > 0 && u.Total > 0 {
		return min(1, float64(u.Total)/float64(m.ContextWindow))
	}
	return -1
}

// composerFooter is the row under the card: where the session runs, which
// agent it carries, what is failing, and the usage panel.
func (a *app) composerFooter(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, MinWidth: core.Pt(0)}, Children: []core.Node{
			core.Show{When: func() bool { return s.readySig.Get() }, Then: func(*core.Scope) core.Node {
				return core.View{TestID: "pi-ready", Label: apptext.T("pi 就绪"),
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, Background: colors.Up()}
					}}
			}},
			hintOf(func() string { return apptext.T("项目 · 点一下换") }, a.projectMenu(s, s.projectOpen)),
			a.composerBackendPicker(s),
			a.personaChip(s),
			core.Show{When: func() bool { return s.notice.Get() != "" }, Then: func(cx *core.Scope) core.Node {
				return core.Text{ContentFunc: func() string { return shorten(s.notice.Get(), 40) }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexShrink: 1, FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)}
			}},
			core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}},
			hintOf(func() string { return apptext.T("用量与上下文") }, a.usageMenu(s, s.usageOpen)),
		}}
	}
}

// attachments previews pasted images above the input.
func (a *app) attachments(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		images := s.images.Get()
		var children []core.Node
		for i, img := range images {
			idx := i
			children = append(children, chat.AttachmentPreview{
				Label: img.Name, RemoveLabel: apptext.T("移除图片"), Image: core.ImageSource{Data: img.Data},
				OnRemove: func() {
					s.images.Update(func(list []remotewire.Image) []remotewire.Image {
						if idx < len(list) {
							return append(append([]remotewire.Image(nil), list[:idx]...), list[idx+1:]...)
						}
						return list
					})
				},
			})
		}
		return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: children}
	}
}
