//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"context"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
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
				controls = append(controls, a.modelMenu(s, s.modelOpen), a.effortPicker(s))
			}
			return core.View{TestID: "composer-model-controls",
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, FlexShrink: 1, MinWidth: core.Pt(0), MaxWidth: core.Pct(100)}, Children: controls}
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
			a.usageStatsLine(s),
		}}
	}
}

// attachments previews pasted images above the input: a click enlarges one,
// and its own menu copies or saves the bytes the composer holds.
func (a *app) attachments(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		images := s.images.Get()
		children := make([]core.Node, 0, len(images))
		for i, img := range images {
			idx, image := i, img
			children = append(children, base.ContextMenu{
				Trigger: a.attachmentTile(cx, image, func() { a.dropImage(s, idx) }),
				TestID:  "attach-image-menu", PopupStyle: a.menuPopup(cx),
				PopupStyleFunc: func() core.Style { return a.menuCard(cx) },
				Children: []core.Node{
					a.menuRow(cx, lucide.Copy, "复制图片", "", false, func() { a.copyImage(image) }),
					a.menuRow(cx, lucide.Download, "另存图片…", "", false, func() { a.saveImage(cx, image) }),
				},
			})
		}
		return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: children}
	}
}

// attachmentTile is one pasted image: the picture opens the preview, and the
// corner control takes it back out of the composer.
func (a *app) attachmentTile(cx *core.Scope, img remotewire.Image, remove func()) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{Width: core.Pt(64), Height: core.Pt(64), FlexShrink: 0}, Children: []core.Node{
		core.View{OnPress: func(core.PressEvent) { a.attachPreview.Set(img) },
			Role: core.RoleButton, Label: apptext.T("查看图片"), TestID: "attach-image",
			StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(64), Height: core.Pt(64), CornerRadius: 8, Overflow: core.Hidden,
					BorderWidth: 1, BorderColor: colors.Border(), Background: colors.Surface(),
					Hover: &core.Style{BorderColor: colors.Accent()}, FocusVisible: ui.FocusRing(cx, 2)}
			},
			Children: []core.Node{core.Image{Source: core.ImageSource{Data: img.Data}, ResizeMode: core.Cover,
				Label: firstNonEmpty(img.Name, apptext.T("图片")), Style: core.Style{Width: core.Pct(100), Height: core.Pct(100)}}}},
		base.Button{Label: apptext.T("移除图片"), OnPress: func(core.PressEvent) { remove() },
			Style: core.Style{Position: core.Absolute, Top: core.Pt(3), Right: core.Pt(3), Width: core.Pt(18), Height: core.Pt(18),
				CornerRadius: 5, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
			StyleFunc: func() core.Style {
				return core.Style{Background: ui.Alpha(colors.Background(), 0.9),
					Hover: &core.Style{Background: colors.Surface(), BorderWidth: 1, BorderColor: colors.Accent()}}
			},
			Children: []core.Node{ui.Icon(lucide.X, 11, colors.Text)}},
	}}
}
