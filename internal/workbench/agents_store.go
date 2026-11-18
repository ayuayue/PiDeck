//go:build !js && !android && !ios

package workbench

// Custom agents, as the manager dialog reads and writes them. The app
// still accepts agents/*.json written by hand; custom.json is the one
// file the dialog owns, so editing never rewrites a user's other files.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	yaml "go.yaml.in/yaml/v3"
)

// agentFile is one file of agents.
type agentFile struct {
	Agents []agentPersona `json:"agents" yaml:"agents"`
}

// customAgentsFile is the file the manager edits.
func (a *app) customAgentsFile() string {
	dir := a.agentsDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "custom.json")
}

// customAgents reads the manager's own list.
func (a *app) customAgents() []agentPersona {
	path := a.customAgentsFile()
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var file agentFile
	if json.Unmarshal(raw, &file) != nil || len(file.Agents) == 0 {
		if yaml.Unmarshal(raw, &file) != nil {
			return nil
		}
	}
	out := make([]agentPersona, 0, len(file.Agents))
	for _, p := range file.Agents {
		p.ID = strings.TrimSpace(p.ID)
		p.Name = strings.TrimSpace(p.Name)
		p.Description = strings.TrimSpace(p.Description)
		p.Prompt = strings.TrimSpace(p.Prompt)
		if p.ID == "" || p.Name == "" || p.Prompt == "" || !pluginSettingKey.MatchString(p.ID) {
			continue
		}
		p.Icon = nil
		p.Plugin = ""
		out = append(out, p)
	}
	return out
}

// saveCustomAgents writes the manager's list atomically.
func (a *app) saveCustomAgents(list []agentPersona) error {
	path := a.customAgentsFile()
	if path == "" {
		return fmt.Errorf("找不到数据目录")
	}
	if err := os.MkdirAll(a.agentsDir(), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(agentFile{Agents: list}, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, data, 0o644)
}

// isCustomAgent reports whether the manager owns this agent's file.
func (a *app) isCustomAgent(id string) bool {
	for _, p := range a.customAgents() {
		if p.ID == id {
			return true
		}
	}
	return false
}

// upsertAgent adds or updates an agent from the form's fields. oldID is
// the agent being edited, empty for a new one.
func (a *app) upsertAgent(oldID, id, name, description, prompt string) error {
	id = strings.TrimSpace(id)
	name = strings.TrimSpace(name)
	description = strings.TrimSpace(description)
	prompt = strings.TrimSpace(prompt)
	switch {
	case id == "" || name == "" || prompt == "":
		return fmt.Errorf("id、名称和提示词都要填")
	case !pluginSettingKey.MatchString(id):
		return fmt.Errorf("id 只能包含字母、数字、点、下划线和短横线")
	}
	list := a.customAgents()
	if oldID == "" {
		for _, p := range a.agentList() {
			if p.ID == id {
				return fmt.Errorf("已经有这个 id 的智能体")
			}
		}
	} else if oldID != id {
		for _, p := range a.agentList() {
			if p.ID == id {
				return fmt.Errorf("已经有这个 id 的智能体")
			}
		}
	}
	out := make([]agentPersona, 0, len(list)+1)
	replaced := false
	for _, p := range list {
		if p.ID == oldID && oldID != "" {
			p.ID, p.Name, p.Description, p.Prompt = id, name, description, prompt
			replaced = true
		}
		out = append(out, p)
	}
	if !replaced {
		out = append(out, agentPersona{ID: id, Name: name, Description: description, Prompt: prompt})
	}
	if err := a.saveCustomAgents(out); err != nil {
		return err
	}
	a.bumpAgentRev()
	return nil
}

// bumpAgentRev redraws the manager when there is a scope.
func (a *app) bumpAgentRev() {
	if a.agentManageRev != nil {
		a.agentManageRev.Update(func(n int) int { return n + 1 })
	}
}

// removeCustomAgent deletes one the manager owns.
func (a *app) removeCustomAgent(id string) error {
	list := a.customAgents()
	out := make([]agentPersona, 0, len(list))
	for _, p := range list {
		if p.ID != id {
			out = append(out, p)
		}
	}
	if err := a.saveCustomAgents(out); err != nil {
		return err
	}
	a.bumpAgentRev()
	return nil
}
