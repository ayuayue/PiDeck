//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestDelegationLiveReceiptKeepsSourceTurn(t *testing.T) {
	run := toolRun{CallID: "dispatch", Name: "Agent", Action: "子代理", Status: chat.Completed,
		Output: "Agent started in background.\nAgent ID: child-run"}
	turns := []turn{
		{ID: "source", Steps: []turnStep{{ID: "dispatch-step", Tools: []toolRun{run}}}},
		{ID: "notice", Prompt: "<task-notification><task-id>child-run</task-id><status>completed</status></task-notification>"},
	}
	entries := delegations(turns, []toolRun{run})
	if len(entries) != 1 || entries[0].turnID != "source" || entries[0].state != "已完成" {
		t.Fatalf("duplicate live receipt changed the source or terminal state: %+v", entries)
	}
}

func TestDelegationComposerScopesActivityToCurrentSession(t *testing.T) {
	a, screen, current := startNativeSurfaceApp(t)
	var other *session
	onNativeUI(t, screen, a, func() {
		ws := a.workspaceOf(current.WS)
		current.agentClosed = true
		current.File = "/fixture/current.jsonl"
		current.turns.Set([]turn{{ID: "current-turn", Status: chat.Completed, Steps: []turnStep{{ID: "current-step", Tools: []toolRun{
			{CallID: "current-task", Name: "Agent", Action: "子代理", Detail: "当前会话发出的检查", Status: chat.Running},
		}}}}})
		other = a.makeSession(sessionMeta{ID: "other-session", Cwd: current.WS, Title: "同项目其他会话"}, current.Target)
		other.agentClosed = true
		other.loaded.Set(true)
		other.turns.Set([]turn{{ID: "other-turn", Status: chat.Completed, Steps: []turnStep{{ID: "other-step", Tools: []toolRun{
			{CallID: "other-task", Name: "Agent", Action: "子代理", Detail: "其他会话发出的检查", Status: chat.Running},
		}}}}})
		child := a.makeSession(sessionMeta{ID: "direct-child", Cwd: current.WS, Parent: current.File, Title: "当前会话的直接子会话"}, current.Target)
		child.agentClosed = true
		child.loaded.Set(true)
		child.File = "/fixture/child.jsonl"
		grandchild := a.makeSession(sessionMeta{ID: "grandchild", Cwd: current.WS, Parent: child.File, Title: "下级会话发出的任务"}, current.Target)
		grandchild.agentClosed = true
		grandchild.loaded.Set(true)
		ws.Sessions.Set([]*session{current, other, child, grandchild})
	})
	screen.WaitFor("id:composer-delegation-current-task", 5*time.Second)
	screen.WaitFor("id:composer-delegation-session:direct-child", 5*time.Second)
	for _, id := range []string{"other-task", "session:grandchild"} {
		if screen.Exists("id:composer-delegation-" + id) {
			t.Errorf("current session includes unrelated activity %s", id)
		}
	}
	onNativeUI(t, screen, a, func() { a.selectSession(other) })
	screen.WaitFor("id:composer-delegation-other-task", 5*time.Second)
	if screen.Exists("id:composer-delegation-current-task") || screen.Exists("id:composer-delegation-session:direct-child") {
		t.Error("switching sessions retained the previous session's activity")
	}
}

func TestDelegationOverviewPreviewsFourCompactRows(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	onNativeUI(t, screen, a, func() {
		names := []string{"检查已完成的任务", "验证输入框", "检查错误恢复", "审查工作流的依赖关系", "检查当前会话的后台任务", strings.Repeat("检查很长的任务名称 ", 16)}
		var runs []toolRun
		for i, name := range names {
			runs = append(runs, toolRun{CallID: fmt.Sprint(i), Name: "Agent", Action: "子代理", Detail: name,
				Status: chat.Completed, Output: fmt.Sprintf("检查结果 %d：保留原始输出。", i)})
		}
		runs[2].Status = chat.Failed
		runs[3].Action, runs[3].Status = "工作流", chat.Waiting
		runs[4].Status = chat.Running
		s.turns.Set([]turn{{ID: "overview-tasks", Prompt: "分工检查会话界面", Status: chat.Completed,
			Steps: []turnStep{{ID: "overview-calls", Tools: runs}}}})
		a.drawer.Set(true)
	})
	screen.WaitFor("id:delegate-open-4", 5*time.Second)
	visible := 0
	for i := range 6 {
		if screen.Exists("id:delegate-run-" + fmt.Sprint(i)) {
			visible++
		}
	}
	if visible != composerDelegationLimit {
		t.Fatalf("overview preview has %d rows, want %d", visible, composerDelegationLimit)
	}
	for _, id := range []string{"4", "3", "5", "2"} {
		if height := screen.Find("id:delegate-open-" + id).Bounds().Size.Height; height > 29 {
			t.Errorf("overview task %s occupies %v points, want one line", id, height)
		}
	}
	shot(screen, "comparison/delegation-overview")
	screen.Press("id:delegate-show-all")
	screen.WaitFor("id:delegate-history-toggle-0", 5*time.Second)
	if screen.Exists("id:delegate-history-result-5") {
		t.Error("history expanded output without selecting a task")
	}
	if width := screen.Find("id:pane-column").Bounds().Size.Width; width > 761 {
		t.Errorf("history width = %v, want a compact column", width)
	}
	shot(screen, "comparison/delegation-history-collapsed")
	screen.Resize(1000, 760)
	screen.Press("id:delegate-history-toggle-5")
	screen.WaitFor("id:delegate-history-result-5 >> text:检查结果 5", 5*time.Second)
	shot(screen, "comparison/delegation-history-narrow")
}

func TestDelegationBackgroundOpensSourceTool(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	const receipt = "Agent started in background.\nAgent ID: source-agent\nType: Explore"
	onNativeUI(t, screen, a, func() {
		run := toolRun{CallID: "background", Name: "Agent", Action: "子代理", Detail: "检查后台任务的原始记录", Status: chat.Completed, Output: receipt}
		s.turns.Set([]turn{
			{ID: "source", Prompt: "发起后台检查", Final: "任务已派发", Status: chat.Completed, Tools: 1,
				Steps: []turnStep{{ID: "dispatch-step", Tools: []toolRun{run}}}},
			{ID: "later", Prompt: "继续处理其他工作", Final: "正在等待结果", Status: chat.Completed},
		})
		s.liveTools.Set([]toolRun{run})
	})
	screen.WaitFor("id:composer-delegation-background >> text:已转入后台", 5*time.Second)
	screen.Press("id:composer-delegation-background")
	screen.WaitFor("id:tool-output >> text:Agent started in background.", 5*time.Second)
	screen.Press("id:composer-delegation-all")
	screen.WaitFor("id:delegate-history-open-background", 5*time.Second)
	screen.Press("id:delegate-history-open-background")
	screen.WaitFor("id:tool-output >> text:Agent started in background.", 5*time.Second)
	if screen.Exists("id:delegate-history") {
		t.Error("opening the source did not return to the conversation")
	}
}
