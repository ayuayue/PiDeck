//go:build !js && !android && !ios

package workbench

// The security gate's host half: three built-in levels, written as a policy
// snapshot for pi-deck-security-gate.ts. The extension enforces it; the app
// only owns the choice and the file.

import (
	"encoding/json"
	"path/filepath"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

const securityPolicyFile = "security-policy.json"

// securityPolicyPath is the snapshot passed to local pi sessions.
var securityPolicyPath string

// securityLevelDef is one level in the snapshot.
type securityLevelDef struct {
	ID                   string            `json:"id"`
	Name                 string            `json:"name"`
	Description          string            `json:"description"`
	Builtin              bool              `json:"builtin"`
	ToolActions          map[string]string `json:"toolActions"`
	DenyBashPatterns     []string          `json:"denyBashPatterns"`
	PathPolicy           string            `json:"pathPolicy"`
	CustomAllowDirs      []string          `json:"customAllowDirs"`
	DenyDirs             []string          `json:"denyDirs"`
	ProtectSensitivePath bool              `json:"protectSensitivePaths"`
	DefaultAction        string            `json:"defaultAction"`
}

// securityPolicy is the snapshot the extension reads.
type securityPolicy struct {
	SchemaVersion  int                `json:"schemaVersion"`
	Enabled        bool               `json:"enabled"`
	DefaultLevelID string             `json:"defaultLevelId"`
	Levels         []securityLevelDef `json:"levels"`
	SessionLevels  map[string]string  `json:"sessionLevels"`
}

// securityDenyBash mirrors PiDeck's default dangerous-command list.
var securityDenyBash = []string{
	`\brm\s+-[a-z]*[rf]`, `\brmdir\b`, `\bmv\b`, `\bcp\b`, `\bchmod\b`, `\bchown\b`,
	`\btee\b`, `\btruncate\b`, `(^|[^<])>(?!>)`, `>>`,
	`\bnpm\s+(install|uninstall|update|ci|link|publish)`,
	`\byarn\s+(add|remove|install|publish)`,
	`\bpnpm\s+(add|remove|install|publish)`,
	`\bpip\s+(install|uninstall)`,
	`\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)`,
	`\bsudo\b`, `\bkill\b`, `(vim|nano|emacs|code|subl)\b`,
}

// securityLevels is the fixed set this build offers.
var securityLevels = map[string]securityLevelDef{
	"off": {
		ID: "off", Name: "关闭", Description: "完全放行所有工具调用。", Builtin: true,
		ToolActions: map[string]string{}, DenyBashPatterns: []string{}, PathPolicy: "unrestricted",
		DefaultAction: "allow",
	},
	"standard": {
		ID: "standard", Name: "标准", Description: "危险命令先确认，敏感文件受保护，目录不限制。", Builtin: true,
		ToolActions: map[string]string{"bash": "ask"}, DenyBashPatterns: securityDenyBash,
		PathPolicy: "unrestricted", ProtectSensitivePath: true, DefaultAction: "allow",
	},
	"strict": {
		ID: "strict", Name: "严格", Description: "只读为主，写操作逐一确认；危险命令确认，文件访问仅限工作目录。", Builtin: true,
		ToolActions: map[string]string{
			"read": "allow", "grep": "allow", "find": "allow", "ls": "allow",
			"write": "ask", "edit": "ask", "bash": "ask", "ask_question": "allow",
		},
		DenyBashPatterns: securityDenyBash, PathPolicy: "workspace",
		ProtectSensitivePath: true, DefaultAction: "deny",
	},
}

// securityLevelID is the configured level, "off" when unset or unknown.
func (a *app) securityLevelID() string {
	if a == nil {
		return "off"
	}
	if _, ok := securityLevels[a.cfg.SecurityLevel]; ok {
		return a.cfg.SecurityLevel
	}
	return "off"
}

// securityPolicyJSON is the snapshot for one level.
func securityPolicyJSON(level string) ([]byte, error) {
	if _, ok := securityLevels[level]; !ok {
		level = "off"
	}
	order := []string{"off", "standard", "strict"}
	levels := make([]securityLevelDef, 0, len(order))
	for _, id := range order {
		level := securityLevels[id]
		if level.CustomAllowDirs == nil {
			level.CustomAllowDirs = []string{}
		}
		if level.DenyDirs == nil {
			level.DenyDirs = []string{}
		}
		if level.DenyBashPatterns == nil {
			level.DenyBashPatterns = []string{}
		}
		if level.ToolActions == nil {
			level.ToolActions = map[string]string{}
		}
		levels = append(levels, level)
	}
	return json.MarshalIndent(securityPolicy{
		SchemaVersion: 1, Enabled: true, DefaultLevelID: level,
		Levels: levels, SessionLevels: map[string]string{},
	}, "", "  ")
}

// writeSecurityPolicy writes the snapshot and returns its path, "" on failure.
func (a *app) writeSecurityPolicy() string {
	if a == nil || a.dataDir == "" {
		return ""
	}
	data, err := securityPolicyJSON(a.securityLevelID())
	if err != nil {
		return ""
	}
	path := filepath.Join(a.dataDir, securityPolicyFile)
	if err := writeFileAtomic(path, append(data, '\n'), 0o644); err != nil {
		return ""
	}
	return path
}

// setSecurityLevel changes the level, writes the snapshot, and lets running
// sessions pick it up on their next tool call.
func (a *app) setSecurityLevel(level string) {
	if _, ok := securityLevels[level]; !ok {
		return
	}
	a.cfg.SecurityLevel = level
	if a.st != nil {
		a.st.edit(func(c *config) { c.SecurityLevel = level })
	}
	path := a.writeSecurityPolicy()
	if path == "" {
		a.toast(ui.ToastError, apptext.T("安全策略保存失败"), apptext.T("策略快照没有写入，扩展仍按上一份文件执行。"))
		return
	}
	securityPolicyPath = path
	a.bumpSettings()
}
