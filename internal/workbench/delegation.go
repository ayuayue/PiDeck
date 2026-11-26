//go:build !js && !android && !ios

package workbench

import (
	"regexp"
	"slices"
	"strings"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

type delegation struct {
	toolRun
	turnID string
	state  string
	child  *session // a persisted child session rather than a tool call
}

func (d delegation) active() bool {
	switch d.state {
	case "启动中", "运行中", "等待中", "待确认", "已转入后台":
		return true
	}
	return false
}

var delegateRunID = regexp.MustCompile("runId `([A-Za-z0-9_-]{1,128})`")
var delegateAgentID = regexp.MustCompile(`(?m)^Agent ID: ([A-Za-z0-9_-]{1,128})\s*$`)

func delegateID(text string) string {
	if match := delegateRunID.FindStringSubmatch(text); len(match) == 2 {
		return match[1]
	}
	if match := delegateAgentID.FindStringSubmatch(text); len(match) == 2 {
		return match[1]
	}
	return ""
}

// delegationNotice reads only the completion envelope the delegate tool
// emits. Ordinary prose that merely mentions a run ID is not a state event.
func delegationNotice(text string) (string, string) {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "<task-notification>") {
		if !strings.Contains(text, "</task-notification>") {
			return "", ""
		}
		// Only inspect the envelope. A task's result can itself quote
		// notifications or contain arbitrary Markdown/XML fragments.
		header, _, _ := strings.Cut(text, "<result>")
		field := func(name string) string {
			_, value, ok := strings.Cut(header, "<"+name+">")
			if !ok {
				return ""
			}
			value, _, ok = strings.Cut(value, "</"+name+">")
			if !ok {
				return ""
			}
			return strings.TrimSpace(value)
		}
		id := field("task-id")
		if id == "" || len(id) > 128 || strings.IndexFunc(id, func(r rune) bool {
			return r != '-' && r != '_' && !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9')
		}) >= 0 {
			return "", ""
		}
		switch strings.ToLower(field("status")) {
		case "completed":
			return id, "已完成"
		case "failed":
			return id, "失败"
		case "cancelled", "canceled", "stopped", "wrapped up (turn limit)":
			return id, "已停止"
		}
		return "", ""
	}
	id := delegateID(text)
	if id == "" {
		return "", ""
	}
	switch {
	case strings.HasPrefix(text, "[acp_delegate completed]"):
		return id, "已完成"
	case strings.HasPrefix(text, "[acp_delegate FAILED"):
		return id, "失败"
	}
	return "", ""
}

// delegations projects recognized tool calls. A dispatch receipt is only
// evidence that a task was handed off. A later completion notice settles it.
func delegations(turns []turn, live []toolRun) []delegation {
	var entries []delegation
	byCall, byRun := map[string]int{}, map[string]int{}
	pendingNotices := map[string]string{}
	add := func(run toolRun, turnID string) {
		if run.CallID == "" || (run.Action != "子代理" && run.Action != "工作流") {
			return
		}
		d := delegation{toolRun: run, turnID: turnID}
		switch {
		case run.IsError || run.Status == chat.Failed:
			d.state = "失败"
		case run.Status == chat.Cancelled:
			d.state = "已停止"
		case run.Status == chat.Running:
			d.state = "运行中"
		case run.Status == chat.Waiting:
			d.state = "等待中"
		case (run.Name == "acp_delegate" && delegateID(run.Output) != "") ||
			(run.Name == "subagent" && strings.Contains(run.Output, "The async run is detached")) ||
			((run.Name == "Agent" || run.Name == "agent") && strings.HasPrefix(run.Output, "Agent started in background.")):
			d.state = "已转入后台"
		case run.Output == "":
			d.state = "没有结果"
		default:
			d.state = "已完成"
		}
		i, found := byCall[run.CallID]
		if found {
			// A live receipt may outlive its source turn. Keep navigation tied
			// to the original dispatch, not the latest notification turn.
			d.turnID = entries[i].turnID
			// A duplicate live dispatch receipt cannot undo a later
			// completion notice already recorded in the transcript.
			if d.state == "已转入后台" && !entries[i].active() {
				d.state = entries[i].state
			}
			entries[i] = d
		} else {
			i = len(entries)
			entries = append(entries, d)
			byCall[run.CallID] = i
		}
		if id := delegateID(run.Output); id != "" && d.state == "已转入后台" {
			byRun[id] = i
		}
	}
	settle := func(text string) {
		id, state := delegationNotice(text)
		if state == "" {
			return
		}
		if i, ok := byRun[id]; ok {
			if entries[i].state == "已转入后台" {
				entries[i].state = state
			}
		} else {
			pendingNotices[id] = state
		}
	}
	for _, t := range turns {
		settle(t.Prompt)
		for _, step := range t.Steps {
			for _, run := range step.Tools {
				add(run, t.ID)
			}
			if step.Note != "" {
				settle(step.Text)
			}
		}
	}
	if len(turns) > 0 {
		for _, run := range live {
			add(run, turns[len(turns)-1].ID)
		}
		for id, state := range pendingNotices {
			if i, ok := byRun[id]; ok && entries[i].state == "已转入后台" {
				entries[i].state = state
			}
		}
	}
	return entries
}

// sessionDelegations projects only this conversation's tool activity and
// direct child sessions. Active work comes first, newest records first
// within each group; all three activity surfaces share this ordering.
func (a *app) sessionDelegations(s *session) []delegation {
	entries := delegations(s.turns.Get(), s.liveTools.Get())
	_, children := a.sessionRelations(s)
	for _, child := range children {
		entries = append(entries, delegation{toolRun: toolRun{CallID: "session:" + child.ID,
			Name: child.title.Get(), Action: "会话", Detail: child.title.Get(), Output: lastAnswer(child)}, state: sessionDelegationState(child), child: child})
	}
	slices.Reverse(entries)
	slices.SortStableFunc(entries, func(a, b delegation) int {
		if a.active() == b.active() {
			return 0
		}
		if a.active() {
			return -1
		}
		return 1
	})
	return entries
}

// sessionDelegationState is shared by the parent's activity list and the
// child's composer. A system note never replaces the last task's result.
func sessionDelegationState(s *session) string {
	switch {
	case s.askPending.Get() > 0:
		return "待确认"
	case s.status.Get() == statusStarting:
		return "启动中"
	case s.status.Get() == statusWaiting:
		return "等待中"
	case s.busy():
		return "运行中"
	case s.status.Get() == statusFailed:
		return "失败"
	}
	turns := s.turns.Get()
	for i := len(turns) - 1; i >= 0; i-- {
		if turns[i].System {
			continue
		}
		switch turns[i].Status {
		case chat.Completed:
			return "已完成"
		case chat.Failed:
			return "失败"
		case chat.Cancelled:
			return "已停止"
		}
		break
	}
	return "就绪"
}

func (a *app) openDelegation(s *session, d delegation) {
	if d.child != nil {
		if a.byID[d.child.ID] == d.child && !d.child.deleting {
			a.selectSession(d.child)
		}
		return
	}
	if s == nil || a.byID[s.ID] != s || s.deleting {
		return
	}
	for i, tr := range s.turns.GetUntracked() {
		if tr.ID != d.turnID {
			continue
		}
		a.selectSession(s)
		foldKey := s.ID + "/fold/" + tr.ID
		if !s.foldOpen(foldKey, false) {
			s.toggleFold(foldKey, false)
		}
		for _, node := range processNodes(a.processItems(s, func() turn { return tr })) {
			for _, item := range node.members {
				src := stepSource{s: s, turn: func() turn { return tr }, id: func() string { return item.step }}
				if slices.ContainsFunc(blockRuns(src, item.part), func(run toolRun) bool { return run.CallID == d.CallID }) {
					key := s.ID + "/" + node.id
					if !s.procOpen(key, false) {
						s.toggleProc(key, false)
					}
				}
			}
		}
		key := s.ID + "/tool/" + d.CallID
		if !s.toolOpen(key, false) {
			s.toggleOpen(key)
		}
		a.jumpToTurnIndex(s, i)
		return
	}
}
