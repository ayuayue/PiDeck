//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// paletteDialog is the command palette.
func (a *app) paletteDialog() core.Node {
	return ui.CommandDialog{
		Open:         a.palette.Get,
		OnOpenChange: func(open bool, _ base.Reason) { a.palette.Set(open) },
		TestID:       "palette",
		Command: ui.Command{
			Items:       a.commandItems,
			Placeholder: apptext.T("搜索命令、会话或工作区…"),
			SearchLabel: apptext.T("命令"),
			Empty:       apptext.T("没有匹配的命令"),
			OnSelect:    a.runCommand,
		},
	}
}
