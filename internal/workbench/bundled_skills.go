//go:build !js && !android && !ios

package workbench

// The skills this app installs for pi: a shared MCP guide in pi's own skills
// folder, and this app's capability router in a folder only --skill loads.
// An existing skill is never overwritten.

import (
	"os"
	"path/filepath"

	"example.com/pideck/assets"
)

// pideckSkillPath is the skill directory passed to pi with --skill, "" when
// the skill was not installed by this run.
var pideckSkillPath string

func installBundledSkills() {
	dir := piConfigDir()
	if dir == "" {
		return
	}
	writeBundledSkill(filepath.Join(dir, "skills", "mcp-setup"), assets.SkillMCPSetup)
	if path := writeBundledSkill(filepath.Join(dir, "pideck-skills", "pideck-v2"), assets.SkillPiDeck); path != "" {
		pideckSkillPath = filepath.Dir(path)
	}
}

// writeBundledSkill writes SKILL.md only when the folder has no skill yet;
// an existing copy, whoever installed it, is used as it is.
func writeBundledSkill(dir string, content []byte) string {
	if dir == "" {
		return ""
	}
	path := filepath.Join(dir, "SKILL.md")
	if _, err := os.Stat(path); err == nil {
		return path
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ""
	}
	if err := writeFileAtomic(path, content, 0o644); err != nil {
		return ""
	}
	return path
}
