//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"strings"

	"example.com/pideck-lite/internal/apptext"
)

const (
	litePluginRuntime = "pideck-lite"
	litePluginSchema  = 2
)

// normalizePluginIdentity migrates legacy identity in memory. It never
// edits the manifest and never interprets a foreign runtime as Lite.
func normalizePluginIdentity(p *plugin) bool {
	p.Runtime = strings.TrimSpace(p.Runtime)
	if p.Runtime == "" {
		p.Runtime = litePluginRuntime
	}
	if p.SchemaVersion == 0 {
		p.SchemaVersion = litePluginSchema
	}
	if p.Runtime != litePluginRuntime || p.SchemaVersion != litePluginSchema {
		p.Error = apptext.T("插件清单不兼容：%s", fmt.Sprintf("runtime=%q, schemaVersion=%d", p.Runtime, p.SchemaVersion))
		return false
	}
	return true
}

// hasContributions includes plugins made solely of agents or keybindings.
func (p plugin) hasContributions() bool {
	return len(p.Commands)+len(p.ThemeSpecs)+len(p.Contributes.Settings)+
		len(p.Contributes.Hooks)+len(p.Contributes.Agents)+len(p.Contributes.Keybindings) > 0
}
