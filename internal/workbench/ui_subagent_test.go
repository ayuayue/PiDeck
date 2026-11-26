//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestDelegationTaskNotificationsSettleBackground(t *testing.T) {
	for _, tc := range []struct{ status, want string }{
		{"completed", "已完成"},
		{"failed", "失败"},
		{"cancelled", "已停止"},
		{"Wrapped up (turn limit)", "已停止"},
		{"running", "已转入后台"},
	} {
		t.Run(tc.status, func(t *testing.T) {
			run := toolRun{CallID: "dispatch", Name: "Agent", Action: "子代理", Status: chat.Completed,
				Output: "Agent started in background.\nAgent ID: child-run\nType: Explore"}
			notice := "<task-notification>\n<task-id>child-run</task-id>\n<status>" + tc.status + "</status>\n<result>review result</result>\n</task-notification>\nFull transcript available at: fixture.output"
			turns := []turn{
				{ID: "source", Steps: []turnStep{{Tools: []toolRun{run}}}},
				{ID: "wake", Prompt: notice},
			}
			entries := delegations(turns, []toolRun{run})
			if len(entries) != 1 || entries[0].state != tc.want {
				t.Fatalf("notification status %q projected %+v, want %q", tc.status, entries, tc.want)
			}
			// A fast background result may arrive before the dispatch
			// receipt moves from liveTools into the committed transcript.
			entries = delegations(turns[1:], []toolRun{run})
			if len(entries) != 1 || entries[0].state != tc.want {
				t.Fatalf("live receipt ignored notification: %+v, want %q", entries, tc.want)
			}
		})
	}
	for _, text := range []string{
		"Example: <task-notification><task-id>child-run</task-id><status>completed</status></task-notification>",
		"<task-notification><task-id>../invalid</task-id><status>completed</status></task-notification>",
		"<task-notification><task-id>child-run</task-id><status>completed</status>",
	} {
		if _, state := delegationNotice(text); state != "" {
			t.Errorf("ordinary or incomplete text changed task state: %q", text)
		}
	}
}

func TestComposerDelegationUpdatesAndOpensHistory(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	onNativeUI(t, screen, a, func() {
		s.turns.Set([]turn{{ID: "delegating", Prompt: "分工检查改动", Status: chat.Running, Start: a.cx.Now(), Steps: []turnStep{{ID: "calls", Tools: []toolRun{
			{CallID: "review", Name: "Agent", Action: "子代理", Detail: "检查会话状态同步", Status: chat.Running},
			{CallID: "tests", Name: "Agent", Action: "子代理", Detail: "验证副会话再次唤起", Status: chat.Running},
		}}}}})
		s.runningSig.Set(true)
	})
	screen.WaitFor("id:composer-delegation-review >> text:运行中", 5*time.Second)
	screen.WaitFor("id:composer-delegations >> text:2 进行中", 5*time.Second)
	// Remember an explicit open choice so terminal results stay visible.
	screen.Press("id:composer-delegation-toggle")
	screen.Press("id:composer-delegation-toggle")
	onNativeUI(t, screen, a, func() {
		a.applyEvent(s, piEvent{Type: "tool_execution_end", ToolCallID: "review", ToolName: "Agent",
			Result: json.RawMessage(`{"content":[{"type":"text","text":"state review passed"}]}`)})
		a.applyEvent(s, piEvent{Type: "tool_execution_end", ToolCallID: "tests", ToolName: "Agent", IsError: true,
			Result: json.RawMessage(`{"content":[{"type":"text","text":"fixture failure detail"}]}`)})
	})
	screen.WaitFor("id:composer-delegation-review >> text:已完成", 5*time.Second)
	screen.WaitFor("id:composer-delegation-tests >> text:失败", 5*time.Second)
	if !screen.Enabled(`id:composer-card >> role:button "发送"`) {
		t.Error("delegation progress disabled sending the existing draft")
	}
	shot(screen, "comparison/composer-delegation")
	screen.Press("id:composer-delegation-all")
	screen.WaitFor("id:delegate-history-list", 5*time.Second)
	if screen.Exists("text:state review passed") || screen.Exists("text:fixture failure detail") {
		t.Error("history expanded results before a task was selected")
	}
	screen.Press("id:delegate-history-toggle-review")
	screen.WaitFor("text:state review passed", 5*time.Second)
	screen.Press("id:delegate-history-toggle-tests")
	screen.WaitFor("text:fixture failure detail", 5*time.Second)
	shot(screen, "comparison/delegation-history")
}

func TestComposerDelegationIsBoundedAndFitsNarrowWindow(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	onNativeUI(t, screen, a, func() {
		var runs []toolRun
		for i := range 80 {
			runs = append(runs, toolRun{CallID: fmt.Sprint(i), Name: "Agent", Action: "子代理", Status: chat.Running,
				Detail: strings.Repeat("检查很长的任务名称和状态 ", 20)})
		}
		s.turns.Set([]turn{{ID: "many-agents", Status: chat.Running, Start: a.cx.Now(), Steps: []turnStep{{ID: "many-calls", Tools: runs}}}})
		s.runningSig.Set(true)
	})
	screen.Resize(1000, 760)
	screen.Press("id:drawer-toggle")
	screen.WaitFor("id:composer-delegation-list", 5*time.Second)
	if rows := len(screen.QueryMounted("id:composer-delegation-list >> role:button")); rows >= 40 {
		t.Fatalf("composer eagerly mounted %d delegation rows", rows)
	}
	if height := screen.Find("id:composer-delegation-list").Bounds().Size.Height; height > 4*28+1 {
		t.Fatalf("composer list height = %v, want a four-row viewport", height)
	}
	screen.Scroll("id:composer-delegation-list", 224)
	screen.WaitFor("id:composer-delegation-71", 5*time.Second)
	if screen.Exists("id:composer-delegation-79") {
		t.Error("scrolling did not move past the first delegation")
	}
	column := screen.Find("id:composer-column").Bounds()
	for _, id := range []string{"composer-delegations", "composer-delegation-all", "composer-card"} {
		b := screen.Find("id:" + id).Bounds()
		if b.Origin.X < column.Origin.X-1 || b.Origin.X+b.Size.Width > column.Origin.X+column.Size.Width+1 {
			t.Errorf("%s overflows composer: element=%v column=%v", id, b, column)
		}
	}
	if !screen.Enabled(`id:composer-card >> role:button "发送"`) {
		t.Error("the delegation strip blocked the input in a narrow window")
	}
	shot(screen, "comparison/composer-delegation-narrow")
}

func TestComposerChildSessionWakesAndReturnsToParent(t *testing.T) {
	a, screen, parent := startNativeSurfaceApp(t)
	var child *session
	onNativeUI(t, screen, a, func() {
		ws := a.workspaceOf(parent.WS)
		parent.agentClosed = true
		parent.File = "/fixture/parent.jsonl"
		child = a.makeSession(sessionMeta{ID: "child-context", Cwd: parent.WS, Parent: parent.File, Title: "副会话状态检查"}, parent.Target)
		child.agentClosed = true
		child.loaded.Set(true)
		child.turns.Set([]turn{{ID: "child-ended", Prompt: "检查结束后再次运行的状态", Final: "第一次检查完成", Status: chat.Completed}})
		child.draft.Set("保留的子会话草稿")
		ws.Sessions.Update(func(list []*session) []*session { return append(list, child) })
	})
	screen.WaitFor("id:composer-delegations", 5*time.Second)
	screen.Press("id:composer-delegation-toggle")
	screen.WaitFor("id:composer-delegation-session:child-context >> text:已完成", 5*time.Second)
	screen.Press("id:composer-delegation-session:child-context")
	screen.WaitFor("id:composer-subagent-parent", 5*time.Second)
	screen.WaitFor("id:composer-subagent-context >> text:检查结束后再次运行的状态", 5*time.Second)
	if !screen.Enabled(`id:composer-card >> role:button "发送"`) {
		t.Error("an ended child session cannot send its existing draft")
	}
	onNativeUI(t, screen, a, func() {
		child.draft.Set("")
		a.applyEvent(child, piEvent{Type: "agent_start"})
		a.applyEvent(child, piEvent{Type: "message_end", Message: json.RawMessage(`{"role":"user","content":"再次唤起：补充审查"}`)})
	})
	screen.WaitFor(`id:composer-card >> role:button "停止"`, 5*time.Second)
	screen.WaitFor("id:composer-subagent-context >> text:运行中", 5*time.Second)
	screen.WaitFor("id:composer-subagent-context >> text:再次唤起：补充审查", 5*time.Second)
	screen.Type("id:composer", "运行中也能补充消息")
	if !screen.Enabled(`id:composer-card >> role:button "发送"`) {
		t.Error("a woken child session cannot send a new message")
	}
	shot(screen, "comparison/composer-child-context")
	screen.Press("id:composer-subagent-parent")
	screen.WaitFor("id:composer-delegation-session:child-context >> text:运行中", 5*time.Second)
	onNativeUI(t, screen, a, func() {
		if a.activeID.GetUntracked() != parent.ID || child.draft.GetUntracked() != "运行中也能补充消息" {
			t.Error("returning to the parent changed the child's retained draft")
		}
		a.applyEvent(child, piEvent{Type: "agent_settled", Aborted: true})
	})
	screen.WaitFor("id:composer-delegation-session:child-context >> text:已停止", 5*time.Second)
	onNativeUI(t, screen, a, func() {
		a.addNote(child, "compaction", "上下文已压缩", "独立的系统记录", chat.Completed)
	})
	screen.WaitFor("id:composer-delegation-session:child-context >> text:已停止", 5*time.Second)
	screen.Press("id:composer-delegation-session:child-context")
	screen.WaitFor("id:composer-subagent-context >> text:已停止", 5*time.Second)
}

func TestDelegationProjectionKeepsBackgroundReceiptsActive(t *testing.T) {
	for _, tc := range []struct{ name, output string }{
		{"Agent", "Agent started in background.\nAgent ID: child-run\nType: Explore"},
		{"acp_delegate", "Dispatched runId `del_1`"},
		{"subagent", "The async run is detached"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run := toolRun{CallID: "dispatch", Name: tc.name, Action: "子代理", Status: chat.Completed, Output: tc.output}
			entries := delegations([]turn{{ID: "dispatch-turn", Steps: []turnStep{{Tools: []toolRun{run}}}}}, nil)
			if len(entries) != 1 || entries[0].state != "已转入后台" || !entries[0].active() {
				t.Fatalf("dispatch receipt was shown as completed: %+v", entries)
			}
		})
	}
	action, detail := toolSummary("SubagentWorkflow", json.RawMessage(`{"description":"审查工作流"}`))
	if action != "工作流" || detail != "审查工作流" {
		t.Errorf("workflow summary = %q, %q", action, detail)
	}
}
