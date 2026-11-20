//go:build !js && !android && !ios

package workbench

import (
	"regexp"
	"strings"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

type delegation struct {
	toolRun
	turnID string
	state  string
}

var delegateRunID = regexp.MustCompile("runId `([A-Za-z0-9_-]{1,128})`")

func delegateID(text string) string {
	if match := delegateRunID.FindStringSubmatch(text); len(match) == 2 {
		return match[1]
	}
	return ""
}

// delegations projects recognized tool calls. A dispatch receipt is only
// evidence that a task was handed off. A later ACP notice can settle it.
func delegations(turns []turn, live []toolRun) []delegation {
	var entries []delegation
	byCall, byRun := map[string]int{}, map[string]int{}
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
		case (run.Name == "acp_delegate" && delegateID(run.Output) != "") ||
			((run.Name == "subagent") && strings.Contains(run.Output, "The async run is detached")):
			d.state = "已转入后台"
		case run.Output == "":
			d.state = "没有结果"
		default:
			d.state = "已完成"
		}
		i, found := byCall[run.CallID]
		if found {
			entries[i] = d
		} else {
			i = len(entries)
			entries = append(entries, d)
			byCall[run.CallID] = i
		}
		if run.Name == "acp_delegate" && d.state == "已转入后台" {
			byRun[delegateID(run.Output)] = i
		}
	}
	for _, t := range turns {
		if i, ok := byRun[delegateID(t.Prompt)]; ok && entries[i].state == "已转入后台" {
			switch {
			case strings.HasPrefix(t.Prompt, "[acp_delegate completed]"):
				entries[i].state = "已完成"
			case strings.HasPrefix(t.Prompt, "[acp_delegate FAILED"):
				entries[i].state = "失败"
			}
		}
		for _, step := range t.Steps {
			for _, run := range step.Tools {
				add(run, t.ID)
			}
		}
	}
	if len(turns) > 0 {
		for _, run := range live {
			add(run, turns[len(turns)-1].ID)
		}
	}
	return entries
}
