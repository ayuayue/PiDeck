//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

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
		return core.Group{
			a.menuSeparator(cx),
			core.Each(func() []string { return texts }, func(text string) string { return text }, func(cx *core.Scope, text func() string, _ func() int) core.Node {
				return ui.MenuItem{Text: text(), Icon: lucide.MessageSquare, TestID: "reply-action-" + text(),
					Disabled: func() bool { s.status.Get(); return !a.shortcutSendAllowed(s) }, OnSelect: func() {
						// A queued native click may belong to an older reply.
						latest := s.turns.GetUntracked()
						if len(latest) == 0 || latest[len(latest)-1].ID != t().ID || latest[len(latest)-1].running() {
							return
						}
						a.sendShortcut(s, text())
					}}
			}),
		}
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
		return ui.Dialog{Title: apptext.T("快捷短语与回复规则"), TestID: "reply-shortcuts-dialog",
			Style: core.Style{Width: core.Pt(640), Height: core.Pt(520)},
			Open:  func() bool { return q.form.Get() != nil }, OnOpenChange: func(open bool, _ base.Reason) {
				if !open && !f.busy.GetUntracked() {
					q.form.Set(nil)
				}
			},
			Children: []core.Node{
				ui.Tabs[string]{Variant: ui.TabsUnderline, Size: ui.SizeSmall, Value: f.section.Get, OnChange: f.section.Set,
					Label: apptext.T("快捷短语与回复规则"), TestID: "shortcut-settings-tabs", Options: []ui.Option[string]{
						{Value: "phrases", Label: apptext.T("快捷短语"), TestID: "shortcut-tab-phrases"},
						{Value: "rules", Label: apptext.T("回复规则"), TestID: "shortcut-tab-rules"},
					}},
				core.View{Style: ui.FillRest, Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
					if f.section.Get() == "rules" {
						return a.replyShortcutRulesPane(cx, f)
					}
					return a.replyShortcutPhrasesPane(cx, f)
				})}},
				core.Show{When: func() bool { return f.message.Get() != "" }, Then: func(*core.Scope) core.Node {
					return core.Text{ContentFunc: f.message.Get, TestID: "shortcut-settings-error", Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Danger)}
				}},
			}, Footer: []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Width: core.Pct(100), Gap: 8,
				Padding: core.Edges{Top: 12}, Borders: core.Edges{Top: 1}},
				StyleFunc: func() core.Style { return core.Style{BorderColors: core.EdgeColors{Top: colors.Line()}} }, Children: []core.Node{
					ui.Button{Text: apptext.T("恢复默认"), Icon: lucide.RotateCcw, TestID: "shortcut-defaults", Variant: ui.ButtonGhost, Disabled: f.busy.Get,
						OnPress: func() { a.fillReplyShortcutForm(f, defaultReplyShortcuts()); f.message.Set("") }},
					core.View{Style: core.Style{FlexGrow: 1}},
					ui.Button{Text: apptext.T("取消"), TestID: "shortcut-cancel", Variant: ui.ButtonGhost, Disabled: f.busy.Get, OnPress: func() { q.form.Set(nil) }},
					ui.Button{Text: apptext.T("保存"), TestID: "shortcut-save", Disabled: f.busy.Get, OnPress: func() { a.saveReplyShortcutForm(f) }},
				}}},
		}
	})
}

func (a *app) replyShortcutPhrasesPane(cx *core.Scope, f *replyShortcutForm) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{TestID: "shortcut-phrases-pane", Style: ui.FillRest.Merge(core.Style{Gap: 10}), Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12}, Children: []core.Node{
			core.Text{Content: apptext.T("在输入框中快速插入或发送，每行一条。"), Style: core.Style{FlexGrow: 1, FlexShrink: 1, FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)},
			core.Text{ContentFunc: func() string { return fmt.Sprintf("%d / %d", len(shortcutLines(f.phrases.Get())), replyShortcutsLimit) }, TestID: "shortcut-phrases-count",
				Style: core.Style{FontSize: 11, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Muted)},
		}},
		core.Input{Ref: f.phraseRef, Value: f.phrases.Get, OnChange: f.phrases.Set, Multiline: true, Disabled: f.busy.Get,
			Label: apptext.T("每行一条快捷短语"), TestID: "shortcut-phrases", Placeholder: apptext.T("每行一条快捷短语"),
			StyleFunc: func() core.Style {
				return panelFieldStyle(colors).Merge(core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(80), TextAlignVertical: core.TextAlignVerticalTop,
					FontSize: a.composerFont(), LineHeight: a.composerLine(), Padding: core.All(12)})
			}},
		core.Text{Content: apptext.T("短语与规则各最多 30 条。发送按钮只发送自身文本，保留当前草稿和附件。"),
			Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)},
	}}
}

func (a *app) replyShortcutRulesPane(cx *core.Scope, f *replyShortcutForm) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{TestID: "shortcut-rules-pane", Style: ui.FillRest.Merge(core.Style{Gap: 8}), Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			core.Text{Content: apptext.T("最新回复结束后，按条件显示发送按钮。"), Style: core.Style{FlexGrow: 1, FlexShrink: 1, FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)},
			core.Text{ContentFunc: func() string { return fmt.Sprintf("%d / %d", len(f.rules.Get()), replyShortcutsLimit) }, TestID: "shortcut-rules-count",
				Style: core.Style{FontSize: 11, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Muted)},
			ui.Button{Text: apptext.T("添加规则"), Icon: lucide.Plus, TestID: "shortcut-rule-add", Size: ui.SizeSmall, Variant: ui.ButtonSecondary,
				Disabled: func() bool { return f.busy.Get() || len(f.rules.Get()) >= replyShortcutsLimit }, OnPress: func() {
					rule := a.makeReplyRuleForm(replyActionRule{Triggers: []replyActionTrigger{{Kind: "onStop"}}})
					f.rules.Update(func(rs []*replyRuleForm) []*replyRuleForm { return append(append([]*replyRuleForm(nil), rs...), rule) })
					f.window.Set(max(f.window.GetUntracked(), len(f.rules.GetUntracked())))
					f.editing.Set(rule.id)
					cx.Post(rule.textRef.Focus)
				}},
		}},
		core.Scroll{TestID: "shortcut-rules-list", Style: ui.FillRest, Children: []core.Node{
			core.View{Children: []core.Node{
				core.Show{When: func() bool { return !f.busy.Get() && len(f.rules.Get()) == 0 }, Then: func(*core.Scope) core.Node {
					return core.Text{Content: apptext.T("还没有回复规则。添加一条，设置按钮文本和显示条件。"), TestID: "shortcut-rules-empty",
						Style: core.Style{FontSize: 12, Padding: core.Symmetric(28, 8)}, StyleFunc: ui.Colored(colors.Muted)}
				}},
				core.Each(func() []*replyRuleForm { rules := f.rules.Get(); return rules[:min(len(rules), f.window.Get())] }, func(r *replyRuleForm) string { return r.id }, func(cx *core.Scope, r func() *replyRuleForm, _ func() int) core.Node {
					return a.replyRuleEditor(cx, f, r())
				}),
				core.Show{When: func() bool { return len(f.rules.Get()) > f.window.Get() }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: apptext.T("加载更多"), TestID: "shortcut-rules-more", Size: ui.SizeSmall, Variant: ui.ButtonGhost,
						Style: core.Style{Width: core.Pct(100), Margin: core.Edges{Top: 8}}, OnPress: func() { f.window.Update(func(n int) int { return n + 6 }) }}
				}},
			}},
		}},
	}}
}

func (a *app) replyRuleEditor(cx *core.Scope, f *replyShortcutForm, r *replyRuleForm) core.Node {
	colors, id := ui.ColorsOf(cx), r.id
	open := func() bool { return f.editing.Get() == id }
	title := func() string {
		if text := strings.TrimSpace(r.text.Get()); text != "" {
			return text
		}
		return apptext.T("未命名规则")
	}
	return base.Collapsible{Open: open, TestID: id,
		Style:     core.Style{Borders: core.Edges{Bottom: 1}},
		StyleFunc: func() core.Style { return core.Style{BorderColors: core.EdgeColors{Bottom: colors.Line()}} },
		Children: []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
			base.Button{LabelFunc: title, Expanded: open, Disabled: f.busy.Get, TestID: id + "-toggle",
				OnPress: func(core.PressEvent) {
					if open() {
						f.editing.Set("")
					} else {
						f.editing.Set(id)
						cx.Post(r.textRef.Focus)
					}
				},
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0),
					Padding: core.Symmetric(10, 6), CornerRadius: 6},
				StyleFunc: func() core.Style {
					return core.Style{Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(cx, -2)}
				},
				Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 3}, Children: []core.Node{
						core.Text{ContentFunc: title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail, Style: core.Style{FontSize: 13, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{ContentFunc: func() string {
							when := apptext.T("每轮结束后")
							switch r.when.Get() {
							case "onStop":
								when = apptext.T("回复成功后")
							case "onFailure":
								when = apptext.T("回复失败后")
							}
							parts := []string{when}
							if strings.TrimSpace(r.patterns.Get()) != "" {
								parts = append(parts, apptext.T("正文匹配"))
							}
							if r.files.Get() {
								parts = append(parts, apptext.T("要求会话有成功的文件修改"))
							}
							return strings.Join(parts, " · ")
						}, MaxLines: 1, EllipsizeMode: core.EllipsizeTail, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
					}},
					ui.IconOf(func() *core.SVG {
						if open() {
							return lucide.ChevronDown()
						}
						return lucide.ChevronRight()
					}, 14, colors.Muted),
				}},
			hintOf(func() string { return apptext.T("删除") }, ui.Button{Icon: lucide.Trash, Label: apptext.T("删除"), TestID: id + "-delete",
				Size: ui.SizeSmall, Variant: ui.ButtonGhost, Disabled: f.busy.Get, OnPress: func() {
					f.rules.Update(func(rs []*replyRuleForm) []*replyRuleForm {
						out := make([]*replyRuleForm, 0, len(rs))
						for _, x := range rs {
							if x != r {
								out = append(out, x)
							}
						}
						return out
					})
					if f.editing.GetUntracked() == id {
						f.editing.Set("")
					}
				}}),
		}}}, Content: core.View{TestID: id + "-fields", Style: core.Style{Gap: 12, Padding: core.Edges{Left: 6, Right: 6, Bottom: 16, Top: 4}}, Children: []core.Node{
			core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
				ui.Text(apptext.T("按钮与发送文本"), 12, ui.Regular, colors.Muted),
				core.Input{Ref: r.textRef, Value: r.text.Get, OnChange: r.text.Set, Disabled: f.busy.Get, Label: apptext.T("按钮与发送文本"), TestID: id + "-text",
					Placeholder: apptext.T("按钮与发送文本"), StyleFunc: func() core.Style { return panelFieldStyle(colors) }},
			}},
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12}, Children: []core.Node{
				ui.Text(apptext.T("何时显示"), 12, ui.Regular, colors.Muted),
				ui.Select[string]{Value: r.when.Get, OnChange: func(v string) { r.conditionsEdited = true; r.when.Set(v) }, Disabled: f.busy.Get,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Label: apptext.T("何时显示"), TestID: id + "-when",
					Options: []ui.Option[string]{{Value: "onStop", Label: apptext.T("回复成功后")}, {Value: "onFailure", Label: apptext.T("回复失败后")}, {Value: "always", Label: apptext.T("每轮结束后")}}},
			}},
			core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
				ui.Text(apptext.T("正文匹配"), 12, ui.Regular, colors.Muted),
				core.Input{Value: r.patterns.Get, OnChange: func(v string) { r.conditionsEdited = true; r.patterns.Set(v) }, Multiline: true, Disabled: f.busy.Get,
					TestID: id + "-patterns", Label: apptext.T("匹配正则，每行一条；留空不限正文"), Placeholder: apptext.T("匹配正则，每行一条；留空不限正文"),
					StyleFunc: func() core.Style {
						return panelFieldStyle(colors).Merge(core.Style{Height: core.Pt(64), TextAlignVertical: core.TextAlignVerticalTop})
					}},
			}},
			core.View{Style: core.Style{Direction: core.Row, Gap: 12, AlignItems: core.AlignCenter}, Children: []core.Node{
				core.Text{Content: apptext.T("要求会话有成功的文件修改"), Style: core.Style{FontSize: 12, FlexGrow: 1, FlexShrink: 1}, StyleFunc: ui.Colored(colors.Muted)},
				ui.Switch{Checked: r.files.Get, OnChange: r.files.Set, Disabled: f.busy.Get, Size: ui.SizeSmall, TestID: id + "-files", Label: apptext.T("要求会话有成功的文件修改")},
			}},
		}},
	}
}
