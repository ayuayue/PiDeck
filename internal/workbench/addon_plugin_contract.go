//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"strings"

	"example.com/pideck/internal/apptext"
)

const (
	v2PluginRuntime = "pideck-v2"
	v2PluginSchema  = 2
)

// normalizePluginIdentity migrates legacy identity in memory. It never
// edits the manifest and never interprets a foreign runtime as this application.
func normalizePluginIdentity(p *plugin) bool {
	p.Runtime = strings.TrimSpace(p.Runtime)
	if p.Runtime == "" {
		p.Runtime = v2PluginRuntime
	}
	if p.SchemaVersion == 0 {
		p.SchemaVersion = v2PluginSchema
	}
	if p.Runtime != v2PluginRuntime || p.SchemaVersion != v2PluginSchema {
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
