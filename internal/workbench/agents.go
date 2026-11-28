//go:build !js && !android && !ios

package workbench

// Built-in agents: ways of working that a session keeps. An agent is a
// short instruction put before every prompt, not a separate process, so
// switching one costs nothing and a session still uses the same pi.
//
// The built-in list is followed by any JSON under the data folder's
// agents directory, so a team can add its own without rebuilding the app.

import (
	"os"
	"path/filepath"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	yaml "go.yaml.in/yaml/v3"
)

// agentPersona is one way of working.
type agentPersona struct {
	ID          string `yaml:"id" json:"id"`
	Name        string `yaml:"name" json:"name"`
	Description string `yaml:"description" json:"description"`
	Prompt      string `yaml:"prompt" json:"prompt"`
	// Icon is the built-in's mark; custom agents get the bot.
	Icon func() *core.SVG `yaml:"-" json:"-"`
	// Plugin names the plugin that brought the agent, for the picker.
	Plugin string `yaml:"-" json:"-"`
}

// builtinAgents are the ways of working the app ships with.
func builtinAgents() []agentPersona {
	return []agentPersona{
		{ID: "review", Name: "代码审查", Description: "先列问题与风险，再给最小修复建议，不直接改文件。",
			Icon: lucide.SearchCheck,
			Prompt: "你是一名严格的代码审查者。回答时先按严重程度列出问题与风险，再给出最小修复建议；" +
				"除非我明确要求，不要直接修改文件。"},
		{ID: "explain", Name: "代码讲解", Description: "按结构与数据流讲清一段代码怎么工作。",
			Icon: lucide.BookOpen,
			Prompt: "你是一名耐心的代码讲解者。先给出整体结构，再按数据流讲关键函数与边界情况；" +
				"引用代码时带上文件与行号，避免泛泛而谈。"},
		{ID: "refactor", Name: "重构助手", Description: "小步、可验证地改善结构，保持行为不变。",
			Icon: lucide.Wrench,
			Prompt: "你是一名谨慎的重构者。每次只做一小步可验证的改动，先说明要消除的坏味道与目标结构；" +
				"保持外部行为不变，并在每步后说明如何验证。"},
		{ID: "tests", Name: "测试工程师", Description: "先找边界与失败模式，再补最小可行测试。",
			Icon: lucide.FlaskConical,
			Prompt: "你是一名测试工程师。先列出这个改动的边界条件与可能的失败模式，再补最小可行的测试；" +
				"测试要能独立运行，失败信息要能直接定位问题。"},
		{ID: "docs", Name: "文档写作", Description: "写给人看：先结论，再步骤，最后注意事项。",
			Icon: lucide.FileText,
			Prompt: "你是一名技术文档作者。先给结论与适用场景，再给可照做的步骤，最后写注意事项与常见坑；" +
				"用短句与列表，避免堆术语。"},
	}
}

// agentsDir is where custom agents live.
func (a *app) agentsDir() string {
	if a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "agents")
}

// agentList is the built-ins followed by the files' agents.
func (a *app) agentList() []agentPersona {
	out := builtinAgents()
	seen := map[string]bool{}
	for _, p := range out {
		seen[p.ID] = true
	}
	dir := a.agentsDir()
	if dir == "" {
		return a.withPluginAgents(out, seen)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.IsDir() || !isJSONFile(e.Name()) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var file struct {
			Agents []agentPersona `yaml:"agents" json:"agents"`
		}
		if yaml.Unmarshal(raw, &file) != nil || len(file.Agents) == 0 {
			if yaml.Unmarshal(raw, &file.Agents) != nil {
				continue
			}
		}
		for _, p := range file.Agents {
			p.ID = strings.TrimSpace(p.ID)
			p.Name = strings.TrimSpace(p.Name)
			p.Prompt = strings.TrimSpace(p.Prompt)
			if p.ID == "" || p.Name == "" || p.Prompt == "" || seen[p.ID] || !pluginSettingKey.MatchString(p.ID) {
				continue
			}
			seen[p.ID] = true
			p.Icon = lucide.Bot
			out = append(out, p)
		}
	}
	// Plugins bring their own agents, namespaced by plugin id.
	return a.withPluginAgents(out, seen)
}

// withPluginAgents appends the enabled plugins' agents.
func (a *app) withPluginAgents(out []agentPersona, seen map[string]bool) []agentPersona {
	if a.plugins == nil {
		return out
	}
	for _, p := range a.plugins.GetUntracked() {
		if p.Disabled || p.Error != "" {
			continue
		}
		for _, agent := range p.Contributes.Agents {
			id := p.ID + ":" + agent.ID
			if seen[id] {
				continue
			}
			seen[id] = true
			agent.ID = id
			agent.Plugin = p.Name
			agent.Icon = lucide.Bot
			out = append(out, agent)
		}
	}
	return out
}

// agentByID finds one agent.
func (a *app) agentByID(id string) *agentPersona {
	if id == "" {
		return nil
	}
	for _, p := range a.agentList() {
		if p.ID == id {
			cp := p
			return &cp
		}
	}
	return nil
}

// personaPrompt puts an agent's instruction before a prompt.
func personaPrompt(instruction, text string) string {
	instruction = strings.TrimSpace(instruction)
	if instruction == "" {
		return text
	}
	return instruction + "\n\n" + text
}

// setPersona binds a session to an agent, or clears it.
func (a *app) setPersona(s *session, id string) {
	if s == nil {
		return
	}
	s.personaID = id
	if a.st == nil {
		return
	}
	a.st.edit(func(c *config) {
		if c.SessionPersonas == nil {
			c.SessionPersonas = map[string]string{}
		}
		if id == "" {
			delete(c.SessionPersonas, s.ID)
		} else {
			c.SessionPersonas[s.ID] = id
		}
	})
	a.cfg = a.st.config()
	if s.uiSeq != nil {
		s.uiSeq.Update(func(n int) int { return n + 1 })
	}
}

// newPersonaSession starts a session that works with an agent. The
// backend switch decides between pi and the project's default ACP
// preset; when the picker was opened to bind the active session, it
// only changes that session's agent.
func (a *app) newPersonaSession(p agentPersona) {
	if a.agentApply.GetUntracked() {
		s := a.active()
		if s == nil {
			a.toast(ui.ToastInfo, "先打开一个会话", "再给它选智能体。")
			return
		}
		a.setPersona(s, p.ID)
		a.agentApply.Set(false)
		a.agentOpen.Set(false)
		a.toast(ui.ToastInfo, apptext.T("已启用 ")+apptext.T(p.Name), apptext.T(p.Description))
		return
	}
	var s *session
	if a.agentBackend.GetUntracked() == "acp" {
		ws := a.activeWorkspace()
		if ws == nil {
			a.toast(ui.ToastInfo, "先选一个项目", "ACP 会话要在项目里运行。")
			return
		}
		var preset *acpPreset
		if ws.ACPPreset != "" {
			preset = a.acpPresetByID(ws.ACPPreset)
		}
		if preset == nil {
			list := a.acpPresetList()
			if len(list) > 0 {
				preset = &list[0]
			}
		}
		if preset == nil {
			a.toast(ui.ToastError, "没有 ACP 预设", "先在设置里添加一个 ACP 命令。")
			return
		}
		s = a.newACPSession(ws, *preset)
	} else if ws := a.activeWorkspace(); ws != nil {
		s = a.newProjectSession(ws)
	} else {
		// No project yet: the built-in chat is a fine place to start.
		s = a.openChat()
	}
	if s == nil {
		return
	}
	a.setPersona(s, p.ID)
	s.title.Set(apptext.T(p.Name))
	if a.st != nil {
		a.st.edit(func(c *config) {
			if c.Titles == nil {
				c.Titles = map[string]string{}
			}
			c.Titles[s.ID] = p.Name
		})
	}
	a.toast(ui.ToastInfo, apptext.T("已启用 ")+apptext.T(p.Name), apptext.T(p.Description))
}

// openAgentManager shows the editable list of agents in the work area.
func (a *app) openAgentManager() {
	a.resetAgentForm()
	a.agentManageErr.Set("")
	a.openPane(paneAgents)
}

// resetAgentForm clears the manager's edit fields.
func (a *app) resetAgentForm() {
	a.agentEditID.Set("")
	a.agentEditKey.Set("")
	a.agentEditName.Set("")
	a.agentEditDesc.Set("")
	a.agentEditPrompt.Set("")
}

// editAgent loads one agent into the manager's form.
func (a *app) editAgent(id string) {
	p := a.agentByID(id)
	if p == nil {
		a.agentManageErr.Set("找不到这个智能体")
		return
	}
	a.agentEditID.Set(p.ID)
	a.agentEditKey.Set(p.ID)
	a.agentEditName.Set(p.Name)
	a.agentEditDesc.Set(p.Description)
	a.agentEditPrompt.Set(p.Prompt)
	a.agentManageErr.Set("")
}

// saveAgentForm writes the form's agent.
func (a *app) saveAgentForm() {
	err := a.upsertAgent(a.agentEditID.GetUntracked(), a.agentEditKey.GetUntracked(), a.agentEditName.GetUntracked(),
		a.agentEditDesc.GetUntracked(), a.agentEditPrompt.GetUntracked())
	if err != nil {
		a.agentManageErr.Set(err.Error())
		return
	}
	a.agentManageErr.Set("")
	a.resetAgentForm()
	a.toast(ui.ToastSuccess, "已保存智能体", "")
}

// deleteAgent removes one the manager owns.
func (a *app) deleteAgent(id string) {
	p := a.agentByID(id)
	if p == nil {
		return
	}
	a.askConfirm("删除智能体", "「"+p.Name+"」会从智能体列表里移除；已经绑定它的会话仍保留记录。", "删除", func() {
		if err := a.removeCustomAgent(id); err != nil {
			a.toast(ui.ToastError, "删除失败", err.Error())
			return
		}
		if a.agentEditID.GetUntracked() == id {
			a.resetAgentForm()
		}
		a.toast(ui.ToastInfo, "已删除智能体", p.Name)
	})
}

// personaChip names the session's agent and clears it.
func (a *app) personaChip(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		s.uiSeq.Get() // redraw when the session's agent changes
		p := a.agentByID(s.personaID)
		if p == nil {
			return nil
		}
		return core.View{TestID: "persona-chip", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5,
			Height: core.Pt(24), Padding: core.Symmetric(0, 7), CornerRadius: 12, Background: colors.Inset()},
			Children: []core.Node{
				ui.Icon(lucide.Bot, 11, colors.Accent),
				core.Text{Content: apptext.T(p.Name), MaxLines: 1, Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Muted)},
				core.View{OnPress: func(core.PressEvent) { a.setPersona(s, "") },
					Role: core.RoleButton, Label: apptext.T("清除智能体"), TestID: "persona-clear",
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(14), Height: core.Pt(14), CornerRadius: 7,
							AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
							Hover: &core.Style{Background: colors.Hover()}}
					},
					Children: []core.Node{ui.Icon(lucide.X, 9, colors.Faint)}},
			}}
	})
}

// agentDialog picks an agent for a new session.
func (a *app) agentDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		if a.plugins != nil {
			a.plugins.Get() // rebuild when a plugin's agents arrive
		}
		var rows []core.Node
		for _, p := range a.agentList() {
			agent := p
			icon := agent.Icon
			if icon == nil {
				icon = lucide.Bot
			}
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) {
					a.agentOpen.Set(false)
					a.newPersonaSession(agent)
				},
				Role: core.RoleButton, Label: apptext.T(agent.Name), TestID: "agent-" + agent.ID,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(44),
						Padding: core.Symmetric(4, 8), CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					ui.Icon(icon, 15, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: apptext.T(agent.Name), Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: apptext.T(agent.Description), MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Muted)},
						core.Show{When: func() bool { return agent.Plugin != "" }, Then: func(*core.Scope) core.Node {
							return core.Text{Content: apptext.T("插件") + " · " + agent.Plugin, MaxLines: 1,
								Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
						}},
						core.Show{When: func() bool { return agent.Plugin == "" && a.isCustomAgent(agent.ID) }, Then: func(*core.Scope) core.Node {
							return core.Text{Content: apptext.T("自定义"), MaxLines: 1,
								Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
						}},
					}},
				},
			})
		}
		var footer []core.Node
		if s := a.active(); s != nil && s.personaID != "" {
			footer = append(footer, ui.Button{Text: apptext.T("清除当前会话的智能体"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				OnPress: func() {
					a.setPersona(s, "")
					a.agentOpen.Set(false)
				}})
		}
		footer = append(footer, ui.Button{Text: apptext.T("管理智能体…"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			TestID: "agent-manage",
			OnPress: func() {
				a.agentOpen.Set(false)
				a.openAgentManager()
			}})
		footer = append(footer, ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			OnPress: func() { a.agentOpen.Set(false) }})
		apply := a.agentApply.Get()
		headline := apptext.T("选择后会新建一个会话；它的工作方式会放在每个提问前面。")
		if apply {
			headline = apptext.T("点一个智能体，把它绑定到当前会话。")
		}
		backendChip := func(id, label string) core.Node {
			on := func() bool { return a.agentBackend.Get() == id }
			return core.View{OnPress: func(core.PressEvent) { a.agentBackend.Set(id) }, Role: core.RoleRadio,
				Label: label, TestID: "agent-backend-" + id,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(24),
						Padding: core.Symmetric(0, 10), CornerRadius: 12, Hover: &core.Style{Background: colors.Hover()}}
					if on() {
						st.Background = colors.Pressed()
					}
					return st
				},
				Children: []core.Node{ui.Text(apptext.T(label), 10.5, ui.Medium, colors.Text)}}
		}
		header := []core.Node{
			core.Text{Content: headline, Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
		}
		if !apply {
			header = append(header, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
				ui.Text(apptext.T("新会话后端"), 10, ui.Regular, colors.Faint),
				backendChip("pi", "pi"),
				backendChip("acp", "ACP"),
			}})
		}
		return ui.Dialog{
			Open:         a.agentOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.agentOpen.Set(open) },
			Title:        apptext.T("选择智能体"),
			TestID:       "agent-dialog",
			Style:        core.Style{Width: a.dialogWidth()},
			Children: []core.Node{
				core.View{Style: core.Style{Gap: 6}, Children: header},
				core.View{Style: core.Style{Gap: 2, Margin: core.Edges{Top: 4}}, Children: rows},
				core.Text{Content: apptext.T("自定义智能体放在数据目录的 agents/ 里；插件也可以在 contributes.agents 里带智能体。"),
					Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)},
			},
			Footer: footer,
		}
	})
}
