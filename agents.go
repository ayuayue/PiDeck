package main

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

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
	"go.yaml.in/yaml/v3"
)

// agentPersona is one way of working.
type agentPersona struct {
	ID          string `yaml:"id" json:"id"`
	Name        string `yaml:"name" json:"name"`
	Description string `yaml:"description" json:"description"`
	Prompt      string `yaml:"prompt" json:"prompt"`
	// Icon is the built-in's mark; custom agents get the bot.
	Icon func() *core.SVG `yaml:"-" json:"-"`
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
		return out
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

// newPersonaSession starts a session that works with an agent.
func (a *app) newPersonaSession(p agentPersona) {
	var s *session
	if ws := a.activeWorkspace(); ws != nil {
		s = a.newSession(ws.Path)
	} else {
		// No project yet: the built-in chat is a fine place to start.
		s = a.openChat()
	}
	if s == nil {
		return
	}
	a.setPersona(s, p.ID)
	s.title.Set(T(p.Name))
	if a.st != nil {
		a.st.edit(func(c *config) {
			if c.Titles == nil {
				c.Titles = map[string]string{}
			}
			c.Titles[s.ID] = p.Name
		})
	}
	a.toast(ui.ToastInfo, T("已启用 ")+T(p.Name), T(p.Description))
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
				core.Text{Content: T(p.Name), MaxLines: 1, Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Muted)},
				core.View{OnPress: func(core.PressEvent) { a.setPersona(s, "") },
					Role: core.RoleButton, Label: T("清除智能体"), TestID: "persona-clear",
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
				Role: core.RoleButton, Label: T(agent.Name), TestID: "agent-" + agent.ID,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(44),
						Padding: core.Symmetric(4, 8), CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					ui.Icon(icon, 15, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: T(agent.Name), Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: T(agent.Description), MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Muted)},
					}},
				},
			})
		}
		var footer []core.Node
		if s := a.active(); s != nil && s.personaID != "" {
			footer = append(footer, ui.Button{Text: T("清除当前会话的智能体"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				OnPress: func() {
					a.setPersona(s, "")
					a.agentOpen.Set(false)
				}})
		}
		footer = append(footer, ui.Button{Text: T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			OnPress: func() { a.agentOpen.Set(false) }})
		return ui.Dialog{
			Open:         a.agentOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.agentOpen.Set(open) },
			Title:        T("选择智能体"),
			TestID:       "agent-dialog",
			Style:        core.Style{Width: core.Pt(520)},
			Children: []core.Node{
				core.Text{Content: T("选择后会新建一个会话；它的工作方式会放在每个提问前面。"),
					Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
				core.View{Style: core.Style{Gap: 2, Margin: core.Edges{Top: 4}}, Children: rows},
				core.Text{Content: T("自定义智能体放在数据目录的 agents/ 里。"),
					Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)},
			},
			Footer: footer,
		}
	})
}
