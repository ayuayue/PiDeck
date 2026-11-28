//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"example.com/pideck/internal/apptext"
)

// levelLabel names a thinking level in Chinese.
func levelLabel(level string) string {
	switch level {
	case "off":
		return apptext.T("关")
	case "minimal":
		return apptext.T("极简")
	case "low":
		return apptext.T("低")
	case "medium":
		return apptext.T("中")
	case "high":
		return apptext.T("高")
	case "xhigh":
		return apptext.T("极高")
	case "max":
		return apptext.T("最大")
	}
	return level
}
