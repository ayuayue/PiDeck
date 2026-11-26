//go:build !js && !android && !ios

package workbench

import (
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) recordToast(kind ui.ToastType, title, detail string) {
	level := "info"
	switch kind {
	case ui.ToastError:
		level = "error"
	case ui.ToastWarning:
		level = "warn"
	}
	// Success/info descriptions can contain copied text or generated content.
	// Retain failure details for diagnosis, but never ordinary toast bodies.
	if level != "info" && detail != "" {
		a.logEvent(level, "notification", "", "%s：%s", title, detail)
		return
	}
	a.logEvent(level, "notification", "", "%s", title)
}

func (a *app) recordAppEvent(name string, ev appEvent) {
	var summary string
	switch name {
	case eventSessionCreated:
		summary = "创建会话"
	case eventSessionOpened:
		summary = "打开会话"
	case eventSessionDeleted:
		summary = "删除会话"
	case eventTurnStart:
		summary = "回合开始"
	case eventTurnDone:
		summary = "回合结束"
	default:
		return
	}
	id := ""
	if ev.Session != nil {
		id = ev.Session.ID
	}
	a.logEvent("info", "session", id, "%s", summary)
}

// recordACPCall deliberately has no protocol payload arguments. An agent can
// echo the user's prompt in an error, so only method, outcome and duration
// are recorded at this boundary.
func (a *app) recordACPCall(sessionID, method string, elapsed time.Duration, err error) {
	level, outcome := "info", "完成"
	if err != nil {
		level, outcome = "error", "失败"
	}
	a.logEvent(level, "acp", sessionID, "ACP %s %s · %s", method, outcome, elapsed.Round(time.Millisecond))
}

func (a *app) recordACPUpdate(sessionID string, u acpUpdate) {
	// Streaming text chunks are neither logged nor counted individually.
	switch u.Kind {
	case "tool_call", "tool_call_update":
		outcome := "unknown"
		switch u.Status {
		case "pending", "in_progress", "completed", "failed":
			outcome = u.Status
		}
		level := "info"
		if outcome == "failed" {
			level = "error"
		}
		a.logEvent(level, "acp", sessionID, "ACP %s · %s", u.Kind, outcome)
	case "plan", "current_mode_update", "config_option_update", "available_commands_update":
		a.logEvent("info", "acp", sessionID, "ACP %s", u.Kind)
	}
}
