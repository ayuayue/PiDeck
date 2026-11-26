//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
)

func remoteDelegationState(state string) string {
	switch state {
	case "启动中":
		return "starting"
	case "运行中":
		return "running"
	case "等待中":
		return "waiting"
	case "待确认":
		return "approval"
	case "已转入后台":
		return "background"
	case "已完成":
		return "completed"
	case "失败":
		return "failed"
	case "已停止":
		return "stopped"
	case "没有结果":
		return "empty"
	}
	return "ready"
}

func remoteSessionRef(s *session) remotewire.SessionRef {
	return remotewire.SessionRef{ID: s.ID, Title: s.title.GetUntracked(), State: remoteDelegationState(sessionDelegationState(s))}
}

// Remote views use the desktop's parent resolution and task lifecycle. A
// transcript path, tool output, or a delegate's private file never becomes a link.
func (a *app) remoteSessionActivity(s *session) remotewire.SessionActivity {
	var activity remotewire.SessionActivity
	parent, children := a.sessionRelations(s)
	if parent != nil {
		ref := remoteSessionRef(parent)
		activity.Parent = &ref
	}
	for _, child := range children {
		activity.Children = append(activity.Children, remoteSessionRef(child))
	}
	return activity
}

func remoteDelegations(turns []turn, live []toolRun) []remotewire.Delegation {
	turnIndices := make(map[string]int, len(turns))
	for i, turn := range turns {
		turnIndices[turn.ID] = i
	}
	entries := delegations(turns, live)
	out := make([]remotewire.Delegation, 0, len(entries))
	for _, entry := range entries {
		name := entry.Detail
		if name == "" {
			name = entry.Name
		}
		out = append(out, remotewire.Delegation{ID: entry.CallID, Name: viewkit.FirstLine(name, 160),
			State: remoteDelegationState(entry.state), Turn: turnIndices[entry.turnID]})
	}
	return out
}
