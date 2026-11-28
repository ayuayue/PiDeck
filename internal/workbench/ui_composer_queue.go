//go:build !js && !android && !ios

package workbench

import (
	"fmt"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// queuePanel keeps each waiting input keyed through edits and delivery changes.
func (a *app) queuePanel(s *session, editor *core.Ref) core.Node {
	return core.Show{When: func() bool { return len(s.steering.Get())+len(s.sending.Get()) > 0 },
		Then: func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			busy := func() bool { return s.queueBusy != nil && s.queueBusy.Get() }
			rows := func(source string, messages func() []queuedMessage) core.Node {
				return core.Each(messages, func(msg queuedMessage) string { return msg.ID },
					func(cx *core.Scope, msg func() queuedMessage, _ func() int) core.Node {
						return a.queueRow(cx, s, msg, source, editor, busy)
					})
			}
			head := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Icon(lucide.ListOrdered, 12, colors.Muted),
				ui.Textf(func() string { return apptext.T("%d 条在排队", len(s.steering.Get())+len(s.sending.Get())) }, 10.5, ui.Medium, colors.Muted),
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: apptext.T("清空"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "queue-clear",
					Disabled: busy, OnPress: func() { a.clearQueue(s) }},
			}}
			return core.View{TestID: "queue-panel",
				Style: core.Style{MinWidth: core.Pt(0), Gap: 2, Margin: core.Edges{Bottom: 6}, Padding: core.Symmetric(6, 10),
					CornerRadius: 10, BorderWidth: 1, BorderColor: colors.Line(), Background: colors.Surface()},
				Children: []core.Node{head, a.scrollStashFor("queuePanel:1").Bind(cx, core.Scroll{TestID: "queue-scroll",
					Style: core.Style{MaxHeight: core.Pt(160), MinWidth: core.Pt(0)},
					Children: []core.Node{core.View{Style: core.Style{Gap: 6, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: []core.Node{
						rows(deliverySteer, s.steering.Get), rows(deliveryFollowUp, s.sending.Get),
					}}}})}}
		}}
}

func (a *app) queueRow(cx *core.Scope, s *session, msg func() queuedMessage, source string, editor *core.Ref, busy func() bool) core.Node {
	colors := ui.ColorsOf(cx)
	kind, target, testID := apptext.T("下一次调用"), apptext.T("排队到下一轮"), "queue-steer"
	if source == deliveryFollowUp {
		kind, target, testID = apptext.T("本轮结束"), apptext.T("加入当前回合"), "queue-followup"
	}
	mode := core.Node(core.View{Style: core.Style{FlexShrink: 0, Padding: core.Symmetric(2, 5), CornerRadius: 5, Background: colors.Inset()},
		Children: []core.Node{ui.Text(kind, 9.5, ui.Medium, colors.Faint)}})
	if backendOf(s) != "acp" {
		mode = ui.Tooltip{Text: target, Trigger: base.Button{Label: target, TestID: "queue-switch", Disabled: busy,
			OnPress: func(core.PressEvent) { a.editQueue(s, msg().ID, source, queueSwitch, editor) },
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, FlexShrink: 0,
				Padding: core.Symmetric(3, 5), CornerRadius: 5},
			StyleFunc: func() core.Style {
				return core.Style{Background: colors.Inset(), Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(cx, 2)}
			}, Children: []core.Node{ui.Text(kind, 9.5, ui.Medium, colors.Muted), ui.Icon(lucide.ArrowLeftRight, 10, colors.Muted)}}}
	}
	return core.View{TestID: testID, Style: core.Style{MinWidth: core.Pt(0), Gap: 4}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(26), MinWidth: core.Pt(0)}, Children: []core.Node{
			mode,
			core.Text{ContentFunc: func() string { return viewkit.FirstLine(msg().Text, 120) }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
			ui.IconButton{Icon: lucide.Undo2, Label: apptext.T("收回输入框"), Size: 24, IconSize: 12, Disabled: busy,
				OnPress: func() { a.editQueue(s, msg().ID, source, queueRecall, editor) }, TestID: "queue-retract"},
			ui.IconButton{Icon: lucide.Trash, Label: apptext.T("删除"), Size: 24, IconSize: 12, Disabled: busy,
				OnPress: func() { a.editQueue(s, msg().ID, source, queueDelete, editor) }, TestID: "queue-delete"},
		}},
		core.Dynamic(func(cx *core.Scope) core.Node {
			m := msg()
			if len(m.Images) == 0 {
				return nil
			}
			pictures := make([]core.Node, 0, len(m.Images))
			for i, image := range m.Images {
				pictures = append(pictures, a.queueImage(cx, image, fmt.Sprintf("queue-image-%s-%d", m.ID, i)))
			}
			return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, MinWidth: core.Pt(0)}, Children: pictures}
		}),
	}}
}

func (a *app) queueImage(cx *core.Scope, image remotewire.Image, id string) core.Node {
	colors := ui.ColorsOf(cx)
	return base.Button{Label: apptext.T("查看图片"), TestID: id,
		OnPress: func(core.PressEvent) { a.attachPreview.Set(image) },
		Style:   core.Style{Width: core.Pt(48), Height: core.Pt(48), FlexShrink: 0, CornerRadius: 6, Overflow: core.Hidden},
		StyleFunc: func() core.Style {
			return core.Style{BorderWidth: 1, BorderColor: colors.Border(), Background: colors.Inset(),
				Hover: &core.Style{BorderColor: colors.Accent()}, FocusVisible: ui.FocusRing(cx, 2)}
		}, Children: []core.Node{core.Image{Source: core.ImageSource{Data: image.Data}, ResizeMode: core.Cover,
			Label: firstNonEmpty(image.Name, apptext.T("图片")), Style: core.Style{Width: core.Pct(100), Height: core.Pct(100)}}}}
}
