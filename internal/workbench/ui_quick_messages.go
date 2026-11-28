//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) quickMessagesPopover(s *session) core.Node {
	q, colors := a.quickReplies, ui.ColorsOf(a.cx)
	triggerRef := new(core.Ref)
	trigger := hintOf(func() string { return apptext.T("快捷短语") }, core.View{
		Ref: triggerRef, Role: core.RoleButton, Label: apptext.T("快捷短语"), TestID: "composer-quick-messages",
		OnPress: func(core.PressEvent) { a.openQuickMessages(s) },
		Style: core.Style{Width: core.Pt(26), Height: core.Pt(26), AlignItems: core.AlignCenter,
			JustifyContent: core.JustifyCenter, CornerRadius: 7},
		StyleFunc: func() core.Style {
			return core.Style{Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(a.cx, 2)}
		},
		Children: []core.Node{ui.Icon(lucide.MessageSquareText, 12.5, colors.Muted)},
	})
	closePicker := func(restoreFocus bool) {
		if q.picker.GetUntracked() != s {
			return
		}
		if restoreFocus {
			triggerRef.Focus()
		}
		q.picker.Set(nil)
	}
	return base.Popover{
		Open: func() bool { return q.picker.Get() == s },
		OnOpenChange: func(open bool, reason base.Reason) {
			if open {
				a.openQuickMessages(s)
			} else {
				closePicker(reason == base.ReasonCancel)
			}
		},
		Placement: core.PlaceTop, Align: core.AlignStart, Offset: 6, Margin: 8,
		Trigger: trigger, Label: apptext.T("快捷短语"), TestID: "quick-messages-popover",
		Style:          core.Style{CornerRadius: 7},
		StyleFunc:      func() core.Style { return core.Style{FocusVisible: ui.FocusRing(a.cx, 2)} },
		PopupStyle:     core.Style{Width: core.Pt(320), MaxWidth: core.Pct(100)},
		PopupStyleFunc: func() core.Style { return a.menuCard(a.cx) },
		Children: []core.Node{core.Func(func(cx *core.Scope) core.Node {
			// A native search field otherwise consumes Escape by blurring.
			cx.OnKeyWith("escape", core.KeyOptions{When: core.KeyAlways}, func() { closePicker(true) })
			return nil
		}), core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			manage := composerRow(cx, lucide.Settings2, apptext.T("快捷短语与回复规则"), "", false, false, a.openReplyShortcutSettings)
			manage.TestID = "quick-messages-manage"
			return core.View{TestID: "quick-messages-dialog", Label: apptext.T("快捷短语"), Style: core.Style{Gap: 4}, Children: []core.Node{
				core.Input{Value: q.query.Get, OnChange: func(v string) { q.window.Set(10); q.query.Set(v) }, AutoFocus: true,
					Label: apptext.T("搜索快捷短语"), Placeholder: apptext.T("搜索快捷短语"), TestID: "quick-messages-search",
					Style: panelFieldStyle(colors).Merge(core.Style{Height: core.Pt(30), FontSize: a.composerFont(), Padding: core.Symmetric(0, 8)})},
				core.Show{When: func() bool { return q.message.Get() != "" }, Then: func(*core.Scope) core.Node {
					return core.Text{ContentFunc: q.message.Get, MaxLines: 2, Style: core.Style{FontSize: 12, Padding: core.Symmetric(2, 6)}, StyleFunc: ui.Colored(colors.Danger)}
				}},
				core.Scroll{Style: core.Style{MaxHeight: core.Pt(228), MinHeight: core.Pt(0)}, Children: []core.Node{
					core.Dynamic(func(cx *core.Scope) core.Node { return a.quickMessageRows(cx, s) }),
				}},
				composerDivider(cx), manage,
			}}
		})},
	}
}

func (a *app) quickMessageRows(cx *core.Scope, s *session) core.Node {
	q, colors := a.quickReplies, ui.ColorsOf(cx)
	if q.loading.Get() {
		return ui.Text(apptext.T("正在读取"), 12, ui.Regular, colors.Muted)
	}
	query := strings.ToLower(strings.TrimSpace(q.query.Get()))
	var items []string
	for _, text := range q.data.Get().QuickMessages {
		if strings.Contains(strings.ToLower(text), query) {
			items = append(items, text)
		}
	}
	var rows []core.Node
	for _, text := range items[:min(len(items), q.window.Get())] {
		insert := ui.Press{Label: text + " · " + apptext.T("插入草稿"), TestID: "quick-insert-" + text,
			Tooltip: hintCard(cx, func() string { return text + " · " + apptext.T("插入草稿") }),
			OnPress: func() { q.picker.Set(nil); a.insertShortcut(s, text) },
			Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), MinHeight: core.Pt(32), JustifyContent: core.JustifyCenter,
				Padding: core.Symmetric(4, 8), CornerRadius: 6},
			StyleFunc: func() core.Style {
				return core.Style{Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(cx, 2)}
			},
			Children: []core.Node{core.Text{Content: text, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: a.composerFont()}, StyleFunc: ui.Colored(colors.Text)}},
		}
		rows = append(rows, core.View{TestID: "quick-message-row-" + text,
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2}, Children: []core.Node{
				insert,
				hintOf(func() string { return apptext.T("直接发送") }, a.pressIcon(lucide.Send, apptext.T("直接发送"), 28, 13,
					func() bool {
						s.status.Get()
						s.retrying.Get()
						s.agentMode.Get()
						s.askPending.Get()
						return !a.shortcutSendAllowed(s)
					}, func() { q.picker.Set(nil); a.sendShortcut(s, text) }, "quick-send-"+text)),
				hintOf(func() string { return apptext.T("编辑") }, a.pressIcon(lucide.Pencil, apptext.T("编辑"), 28, 13, nil,
					func() { a.openReplyShortcutSettingsFor(text) }, "quick-edit-"+text)),
			}})
	}
	if len(items) == 0 {
		rows = append(rows, core.Text{Content: apptext.T("没有匹配的快捷短语"), Style: core.Style{FontSize: 12, Padding: core.Symmetric(8, 8)}, StyleFunc: ui.Colored(colors.Muted)})
	}
	if len(items) > q.window.Get() {
		rows = append(rows, ui.Button{Text: apptext.T("加载更多"), TestID: "quick-messages-more", Size: ui.SizeSmall, Variant: ui.ButtonGhost,
			OnPress: func() { q.window.Update(func(v int) int { return v + 10 }) }})
	}
	return core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: rows}
}
