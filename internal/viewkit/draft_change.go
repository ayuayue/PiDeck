package viewkit

import (
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// DraftChange is one transient replacement preview or undo snapshot. The
// host's draft remains authoritative; this is discarded only by an action.
type DraftChange struct {
	Before, After string
	Applied       bool
}

// DraftChangeBar keeps late model results recoverable beside their draft.
// Hosts own every mutation, including checking that Undo still matches.
type DraftChangeBar struct {
	Change                     func() *DraftChange
	Draft                      func() string
	OnApply, OnUndo, OnDismiss func()
	OnCopy                     func(string)
}

func (b DraftChangeBar) Render(cx *core.Scope) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		change := b.Change()
		if change == nil {
			return nil
		}
		colors := ui.ColorsOf(cx)
		title := apptext.T("结果已就绪，当前草稿已保留")
		if change.Applied {
			title = apptext.T("草稿已更新")
		}
		actions := []core.Node{
			ui.Button{Text: apptext.T("复制结果"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "draft-change-copy",
				OnPress: func() { b.OnCopy(change.After) }},
		}
		if change.Applied {
			if b.Draft() == change.After {
				actions = append(actions, ui.Button{Text: apptext.T("撤销"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "draft-change-undo", OnPress: b.OnUndo})
			} else {
				actions = append(actions, ui.Button{Text: apptext.T("复制原草稿"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "draft-change-original",
					OnPress: func() { b.OnCopy(change.Before) }})
			}
		} else {
			actions = append(actions, ui.Button{Text: apptext.T("替换草稿"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "draft-change-apply", OnPress: b.OnApply})
		}
		actions = append(actions, ui.IconButton{Icon: lucide.X, Label: apptext.T("关闭"), Size: 24, TestID: "draft-change-dismiss", OnPress: b.OnDismiss})
		children := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 6}, Children: append([]core.Node{
				core.Text{Content: title, Style: core.Style{FontSize: 12, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Text)},
			}, actions...)},
		}
		if !change.Applied {
			children = append(children, core.Text{Content: FirstLine(change.After, 200), MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 12, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)})
		}
		return core.View{TestID: "draft-change", Style: core.Style{Gap: 4, Padding: core.Symmetric(6, 10), Background: colors.Surface(),
			BorderWidth: 1, BorderColor: colors.Border(), CornerRadius: ui.RadiusControl}, Children: children}
	})
}
