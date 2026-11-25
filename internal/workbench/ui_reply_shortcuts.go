//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) quickMessagesDialog() core.Node {
	q := a.quickReplies
	return core.Dynamic(func(cx *core.Scope) core.Node {
		s := q.picker.Get()
		if s == nil {
			return nil
		}
		colors := ui.ColorsOf(cx)
		return ui.Dialog{Title: apptext.T("快捷短语"), TestID: "quick-messages-dialog", Style: core.Style{Width: a.dialogWidth()},
			Open: func() bool { return q.picker.Get() != nil }, OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					q.picker.Set(nil)
				}
			},
			Children: []core.Node{
				core.Input{Value: q.query.Get, OnChange: func(v string) { q.window.Set(10); q.query.Set(v) }, AutoFocus: true,
					Label: apptext.T("搜索快捷短语"), Placeholder: apptext.T("搜索快捷短语"), TestID: "quick-messages-search", Style: panelFieldStyle(colors)},
				core.Text{ContentFunc: q.message.Get, StyleFunc: ui.Colored(colors.Danger)},
				core.Scroll{Style: core.Style{Height: core.Pt(320)}, Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
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
						rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: a.composerFont() / 2, Padding: core.Symmetric(a.composerFont()/2, 0)}, Children: []core.Node{
							core.Text{Content: text, MaxLines: 2, EllipsizeMode: core.EllipsizeTail, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: a.composerFont()}, StyleFunc: ui.Colored(colors.Text)},
							ui.Button{Text: apptext.T("插入草稿"), TestID: "quick-insert-" + text, Size: ui.SizeSmall, Variant: ui.ButtonGhost, OnPress: func() { q.picker.Set(nil); a.insertShortcut(s, text) }},
							ui.Button{Text: apptext.T("直接发送"), TestID: "quick-send-" + text, Size: ui.SizeSmall, Variant: ui.ButtonSecondary,
								Disabled: func() bool {
									s.status.Get()
									s.retrying.Get()
									s.agentMode.Get()
									s.askPending.Get()
									return !a.shortcutSendAllowed(s)
								},
								OnPress: func() { q.picker.Set(nil); a.sendShortcut(s, text) }},
						}})
					}
					if len(items) == 0 {
						rows = append(rows, ui.Text(apptext.T("没有匹配的快捷短语"), 12, ui.Regular, colors.Muted))
					}
					if len(items) > q.window.Get() {
						rows = append(rows, ui.Button{Text: apptext.T("加载更多"), TestID: "quick-messages-more", Variant: ui.ButtonGhost, OnPress: func() { q.window.Update(func(v int) int { return v + 10 }) }})
					}
					return core.View{Style: core.Style{Gap: a.composerFont() / 4}, Children: rows}
				})}},
			}, Footer: []core.Node{
				ui.Button{Text: apptext.T("快捷短语与回复规则"), TestID: "quick-messages-manage", Variant: ui.ButtonSecondary, OnPress: a.openReplyShortcutSettings},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, OnPress: func() { q.picker.Set(nil) }},
			}}
	})
}

func (a *app) turnReplyShortcuts(s *session, t func() turn) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		turns := s.turns.Get()
		mode := s.agentMode.Get()
		if len(turns) == 0 || t().ID != turns[len(turns)-1].ID || s.retrying.Get() || s.askPending.Get() > 0 || mode == modeImage {
			return nil
		}
		texts := matchedReplyActions(a.quickReplies.data.Get().ReplyActions, turns)
		if len(texts) == 0 {
			return nil
		}
		return core.View{TestID: "reply-action-strip", Label: apptext.T("回复快捷操作"), Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: a.composerFont() / 4}, Children: []core.Node{
			core.Each(func() []string { return texts }, func(text string) string { return text }, func(cx *core.Scope, text func() string, _ func() int) core.Node {
				return ui.Button{Text: text(), TestID: "reply-action-" + text(), Size: ui.SizeSmall, Variant: ui.ButtonSecondary,
					Disabled: func() bool { s.status.Get(); return !a.shortcutSendAllowed(s) }, OnPress: func() {
						// A queued native click may belong to an older reply.
						latest := s.turns.GetUntracked()
						if len(latest) == 0 || latest[len(latest)-1].ID != t().ID || latest[len(latest)-1].running() {
							return
						}
						a.sendShortcut(s, text())
					}}
			}),
		}}
	})
}

func (a *app) replyShortcutSettingsDialog() core.Node {
	q := a.quickReplies
	return core.Dynamic(func(cx *core.Scope) core.Node {
		f := q.form.Get()
		if f == nil {
			return nil
		}
		colors := ui.ColorsOf(cx)
		return ui.Dialog{Title: apptext.T("快捷短语与回复规则"), TestID: "reply-shortcuts-dialog", Style: core.Style{Width: a.dialogWidth()},
			Open: func() bool { return q.form.Get() != nil }, OnOpenChange: func(open bool, _ base.Reason) {
				if !open && !f.busy.GetUntracked() {
					q.form.Set(nil)
				}
			},
			Children: []core.Node{
				ui.Text(apptext.T("短语与规则各最多 30 条。发送按钮只发送自身文本，保留当前草稿和附件。"), 12, ui.Regular, colors.Muted),
				core.Scroll{Style: core.Style{Height: core.Pt(390)}, Children: []core.Node{core.View{Style: core.Style{Gap: a.composerFont()}, Children: []core.Node{
					ui.Text(apptext.T("快捷短语"), 13, ui.Medium, colors.Text),
					core.Input{Value: f.phrases.Get, OnChange: f.phrases.Set, Multiline: true, Disabled: f.busy.Get, Label: apptext.T("每行一条快捷短语"), TestID: "shortcut-phrases", Placeholder: apptext.T("每行一条快捷短语"), Style: panelFieldStyle(colors).Merge(core.Style{Height: core.Pt(130), TextAlignVertical: core.TextAlignVerticalTop, FontSize: a.composerFont(), LineHeight: a.composerLine()})},
					ui.Text(apptext.T("回复快捷操作"), 13, ui.Medium, colors.Text),
					core.Each(func() []*replyRuleForm { rules := f.rules.Get(); return rules[:min(len(rules), f.window.Get())] }, func(r *replyRuleForm) string { return r.id }, func(cx *core.Scope, r func() *replyRuleForm, _ func() int) core.Node {
						return a.replyRuleEditor(cx, f, r())
					}),
					core.Show{When: func() bool { return len(f.rules.Get()) > f.window.Get() }, Then: func(*core.Scope) core.Node {
						return ui.Button{Text: apptext.T("加载更多"), TestID: "shortcut-rules-more", Variant: ui.ButtonGhost, OnPress: func() { f.window.Update(func(n int) int { return n + 6 }) }}
					}},
					ui.Button{Text: apptext.T("添加规则"), TestID: "shortcut-rule-add", Variant: ui.ButtonSecondary, Disabled: func() bool { return f.busy.Get() || len(f.rules.Get()) >= replyShortcutsLimit }, OnPress: func() {
						rule := a.makeReplyRuleForm(replyActionRule{Triggers: []replyActionTrigger{{Kind: "onStop"}}})
						f.rules.Update(func(rs []*replyRuleForm) []*replyRuleForm { return append(append([]*replyRuleForm(nil), rs...), rule) })
						f.window.Set(replyShortcutsLimit)
					}},
				}}}},
				core.Text{ContentFunc: f.message.Get, Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Danger)},
			}, Footer: []core.Node{
				ui.Button{Text: apptext.T("恢复默认"), TestID: "shortcut-defaults", Variant: ui.ButtonGhost, Disabled: f.busy.Get, OnPress: func() { a.fillReplyShortcutForm(f, defaultReplyShortcuts()); f.message.Set("") }},
				ui.Button{Text: apptext.T("取消"), TestID: "shortcut-cancel", Variant: ui.ButtonGhost, Disabled: f.busy.Get, OnPress: func() { q.form.Set(nil) }},
				ui.Button{Text: apptext.T("保存"), TestID: "shortcut-save", Disabled: f.busy.Get, OnPress: func() { a.saveReplyShortcutForm(f) }},
			}}
	})
}

func (a *app) replyRuleEditor(cx *core.Scope, f *replyShortcutForm, r *replyRuleForm) core.Node {
	colors := ui.ColorsOf(cx)
	id := r.id
	return core.View{TestID: id, Style: core.Style{Gap: a.composerFont() / 2, Padding: core.Edges{Bottom: a.composerFont()}}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, Gap: a.composerFont() / 2, AlignItems: core.AlignCenter}, Children: []core.Node{
			core.Input{Value: r.text.Get, OnChange: r.text.Set, Disabled: f.busy.Get, Label: apptext.T("按钮与发送文本"), TestID: id + "-text", Placeholder: apptext.T("按钮与发送文本"), Style: panelFieldStyle(colors).Merge(core.Style{FlexGrow: 1, MinWidth: core.Pt(0)})},
			ui.Button{Text: apptext.T("删除"), TestID: id + "-delete", Size: ui.SizeSmall, Variant: ui.ButtonGhost, Disabled: f.busy.Get, OnPress: func() {
				f.rules.Update(func(rs []*replyRuleForm) []*replyRuleForm {
					out := make([]*replyRuleForm, 0, len(rs))
					for _, x := range rs {
						if x != r {
							out = append(out, x)
						}
					}
					return out
				})
			}},
		}},
		ui.Select[string]{Value: r.when.Get, OnChange: func(v string) { r.conditionsEdited = true; r.when.Set(v) }, Disabled: f.busy.Get, Label: apptext.T("何时显示"), TestID: id + "-when", Options: []ui.Option[string]{{Value: "onStop", Label: apptext.T("回复成功后")}, {Value: "onFailure", Label: apptext.T("回复失败后")}, {Value: "always", Label: apptext.T("每轮结束后")}}},
		core.Input{Value: r.patterns.Get, OnChange: func(v string) { r.conditionsEdited = true; r.patterns.Set(v) }, Multiline: true, Disabled: f.busy.Get, TestID: id + "-patterns", Label: apptext.T("匹配正则，每行一条；留空不限正文"), Placeholder: apptext.T("匹配正则，每行一条；留空不限正文"), Style: panelFieldStyle(colors).Merge(core.Style{Height: core.Pt(64), TextAlignVertical: core.TextAlignVerticalTop})},
		core.View{Style: core.Style{Direction: core.Row, Gap: a.composerFont() / 2, AlignItems: core.AlignCenter}, Children: []core.Node{
			ui.Switch{Checked: r.files.Get, OnChange: r.files.Set, Disabled: f.busy.Get, TestID: id + "-files", Label: apptext.T("要求会话有成功的文件修改")},
			ui.Text(apptext.T("要求会话有成功的文件修改"), 12, ui.Regular, colors.Muted),
		}},
	}}
}
