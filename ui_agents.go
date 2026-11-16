//go:build !js && !android && !ios

package main

// The agent manager: every built-in, custom and plugin agent in one list,
// with a form that writes custom.json. Editing a built-in is not offered
// because an app update would overwrite it; make a custom copy instead.

import (
	"strings"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// agentManagerDialog draws the list and the form.
func (a *app) agentManagerDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.agentManageRev.Get()
		_ = a.langRev.Get()
		if a.plugins != nil {
			a.plugins.Get()
		}
		editing := a.agentEditID.Get()
		var rows []core.Node
		for _, p := range a.agentList() {
			agent := p
			icon := agent.Icon
			if icon == nil {
				icon = lucide.Bot
			}
			origin := T("内置")
			custom := agent.Plugin == "" && a.isCustomAgent(agent.ID)
			if agent.Plugin != "" {
				origin = T("插件") + " · " + agent.Plugin
			} else if custom {
				origin = T("自定义")
			}
			actions := []core.Node{
				ui.Button{Text: T("使用"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "agent-use-" + agent.ID,
					OnPress: func() {
						a.agentApply.Set(false)
						a.agentManageOpen.Set(false)
						a.newPersonaSession(agent)
					}},
			}
			if custom {
				actions = append(actions,
					ui.Button{Text: T("编辑"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "agent-edit-" + agent.ID,
						OnPress: func() { a.editAgent(agent.ID) }},
					ui.Button{Text: T("删除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "agent-delete-" + agent.ID,
						OnPress: func() { a.deleteAgent(agent.ID) }},
				)
			}
			rowChildren := []core.Node{
				ui.Icon(icon, 14, colors.Muted),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
					core.Text{Content: T(agent.Name), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: T(agent.Description), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
					ui.Text(origin, 9, ui.Regular, colors.Faint),
				}},
			}
			rowChildren = append(rowChildren, actions...)
			rows = append(rows, core.View{TestID: "agent-manage-row-" + agent.ID,
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(46),
					Padding: core.Symmetric(4, 7), CornerRadius: 7},
				Children: rowChildren})
		}
		var bodyRows []core.Node
		if len(rows) == 0 {
			bodyRows = append(bodyRows, core.Text{Content: T("还没有智能体。"), Style: core.Style{FontSize: 11, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)})
		} else {
			bodyRows = append(bodyRows, core.Scroll{Style: core.Style{MaxHeight: core.Pt(230)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: rows}}})
		}

		fieldStyle := core.Style{Height: core.Pt(29), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11.5,
			Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}
		formTitle := T("新建智能体")
		if editing != "" {
			formTitle = T("编辑智能体")
		}
		errText := a.agentManageErr.Get()
		form := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Text(formTitle, 11, ui.Semibold, colors.Text),
				core.View{Style: core.Style{FlexGrow: 1}},
				core.Show{When: func() bool { return editing != "" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: T("取消编辑"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						OnPress: func() { a.resetAgentForm() }}
				}},
			}},
			core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: []core.Node{
				core.View{Style: core.Style{Width: core.Pt(140)}, Children: []core.Node{
					core.Input{Value: a.agentEditKey.Get, OnChange: a.agentEditKey.Set, Placeholder: "id",
						Label: T("智能体 id"), TestID: "agent-field-id", Style: fieldStyle},
				}},
				core.View{Style: core.Style{Width: core.Pt(170)}, Children: []core.Node{
					core.Input{Value: a.agentEditName.Get, OnChange: a.agentEditName.Set, Placeholder: T("名称"),
						Label: T("智能体名称"), TestID: "agent-field-name", Style: fieldStyle},
				}},
				core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
					core.Input{Value: a.agentEditDesc.Get, OnChange: a.agentEditDesc.Set, Placeholder: T("一句话说明"),
						Label: T("智能体说明"), TestID: "agent-field-desc", Style: fieldStyle},
				}},
			}},
			core.Input{Value: a.agentEditPrompt.Get, OnChange: a.agentEditPrompt.Set, Multiline: true,
				Placeholder: T("放在每个提问前面的工作方式，例如：先列风险，再给最小修复。"),
				Label:       T("智能体提示词"), TestID: "agent-field-prompt",
				Style: core.Style{MinHeight: core.Pt(84), Padding: core.Symmetric(6, 8), CornerRadius: 6, FontSize: 11.5,
					Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}},
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				core.Show{When: func() bool { return strings.TrimSpace(errText) != "" }, Then: func(*core.Scope) core.Node {
					return core.Text{Content: a.agentManageErr.Get(), MaxLines: 2, Style: core.Style{FlexGrow: 1, FontSize: 10.5},
						StyleFunc: ui.Colored(colors.Danger)}
				}},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: T("保存智能体"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "agent-save",
					OnPress: a.saveAgentForm},
			}},
		}

		return ui.Dialog{
			Open:         a.agentManageOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.agentManageOpen.Set(open) },
			Title:        T("智能体"),
			Description:  T("智能体是一段放在每个提问前面的工作方式；会话绑定后一直生效，ACP 会话同样适用。"),
			TestID:       "agent-manager",
			Style:        core.Style{Width: core.Pt(760), MaxHeight: core.Pt(660)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: append(bodyRows,
				core.View{Style: core.Style{Gap: 6, Padding: core.Edges{Top: 8}, Borders: core.Edges{Top: 1},
					BorderColor: colors.Line()}, Children: form})}},
			Footer: []core.Node{
				ui.Button{Text: T("新建"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "agent-new",
					OnPress: func() {
						a.resetAgentForm()
						a.agentManageErr.Set("")
					}},
				ui.Button{Text: T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.agentManageOpen.Set(false) }},
			},
		}
	})
}
