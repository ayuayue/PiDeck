//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestCompactionNoteUpdatesInPlace(t *testing.T) {
	for _, tc := range []struct {
		name, end, title, body string
		status                 chat.Status
	}{
		{"success", `{"type":"compaction_end","result":{"summary":"保留了任务目标与验证结论","tokensBefore":120000,"estimatedTokensAfter":18000}}`, "上下文已压缩", "保留了任务目标与验证结论", chat.Completed},
		{"failure", `{"type":"compaction_end","errorMessage":"fixture compaction failed"}`, "压缩失败", "fixture compaction failed", chat.Failed},
		{"cancelled", `{"type":"compaction_end","aborted":true}`, "压缩已取消", "", chat.Cancelled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, screen, s := startNativeSurfaceApp(t)
			onNativeUI(t, screen, a, func() {
				s.turns.Set(nil)
				s.draft.Set("")
				a.applyEvent(s, piEvent{Type: "compaction_start"})
			})
			screen.WaitFor("id:note-card >> text:正在压缩上下文…", 5*time.Second)
			var ev piEvent
			if err := json.Unmarshal([]byte(tc.end), &ev); err != nil {
				t.Fatal(err)
			}
			onNativeUI(t, screen, a, func() { a.applyEvent(s, ev) })
			screen.WaitFor("id:note-card >> text:"+tc.title, 5*time.Second)
			screen.WaitForGone("id:note-card >> text:正在压缩上下文…", 5*time.Second)
			if tc.body != "" {
				screen.WaitFor("id:note-card >> text:"+tc.body, 5*time.Second)
			}
			onNativeUI(t, screen, a, func() {
				turns := s.turns.GetUntracked()
				if len(turns) != 1 || turns[0].Status != tc.status || turns[0].End.IsZero() {
					t.Errorf("compaction = %+v, want one terminal note with status %v", turns, tc.status)
				}
			})
		})
	}
}

func TestCompactionPreservesActiveTurnAndHistory(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	onNativeUI(t, screen, a, func() {
		s.turns.Set([]turn{{ID: "active-turn", Prompt: "继续任务", Status: chat.Running, Start: a.cx.Now()}})
		s.runningSig.Set(true)
		a.applyEvent(s, piEvent{Type: "compaction_start"})
		a.applyEvent(s, piEvent{Type: "compaction_end", Result: json.RawMessage(`{"summary":"第一份摘要"}`)})
		a.applyEvent(s, piEvent{Type: "message_start", Message: json.RawMessage(`{"role":"assistant"}`)})
		a.applyEvent(s, piEvent{Type: "message_end", Message: json.RawMessage(`{"role":"assistant","content":"压缩后继续回答"}`)})
		a.applyEvent(s, piEvent{Type: "agent_settled"})
		for _, tr := range s.turns.GetUntracked() {
			if tr.ID == "active-turn" && (tr.running() || tr.Final != "压缩后继续回答") {
				t.Errorf("original turn lost its answer or stayed running: %+v", tr)
			}
			if tr.System && tr.Final != "" {
				t.Errorf("assistant answer was attached to a system note: %+v", tr)
			}
		}
	})
	screen.Advance(time.Second)
	onNativeUI(t, screen, a, func() {
		a.applyEvent(s, piEvent{Type: "compaction_start"})
		a.applyEvent(s, piEvent{Type: "compaction_end", Result: json.RawMessage(`{"summary":"第二份摘要"}`)})
		notes := 0
		for _, tr := range s.turns.GetUntracked() {
			if tr.System {
				notes++
			}
		}
		if notes != 2 {
			t.Errorf("compaction history has %d notes, want 2", notes)
		}
	})
}

func TestPiBackgroundRunWakesComposer(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	onNativeUI(t, screen, a, func() {
		s.draft.Set("")
		s.loaded.Set(true)
		a.applyEvent(s, piEvent{Type: "agent_start"})
		if !s.busyNow() {
			t.Error("a new backend run did not set the composer's running state")
		}
	})
	screen.WaitFor("id:composer-stop", 5*time.Second)
	onNativeUI(t, screen, a, func() {
		a.applyEvent(s, piEvent{Type: "message_start", Message: json.RawMessage(`{"role":"assistant"}`)})
		a.applyEvent(s, piEvent{Type: "message_end", Message: json.RawMessage(`{"role":"assistant","content":"后台回报已处理"}`)})
		a.applyEvent(s, piEvent{Type: "agent_settled"})
	})
	screen.WaitFor("id:composer-send", 5*time.Second)
	onNativeUI(t, screen, a, func() { a.applyEvent(s, piEvent{Type: "agent_start"}) })
	screen.WaitFor("id:composer-stop", 5*time.Second)
	screen.Type("id:composer", "补充一条要求")
	if !screen.Enabled("id:composer-send") {
		t.Error("a resumed backend run disabled sending a message")
	}
	onNativeUI(t, screen, a, func() { a.applyEvent(s, piEvent{Type: "agent_settled", Aborted: true}) })
	if !screen.Enabled("id:composer-send") {
		t.Error("settling the resumed run disabled the retained draft")
	}
}

func TestPiStreamingHandshakeKeepsCurrentRun(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	onNativeUI(t, screen, a, func() {
		s.draft.Set("")
		a.engineReady(s, nil, nil, "", "", 2, true)
		if !s.busyNow() {
			t.Error("streaming handshake did not wake the composer")
		}
		history := []turn{
			{ID: "restored", Prompt: "后台正在处理的任务", Final: "部分回答", Status: chat.Completed, End: a.cx.Now()},
			{ID: "saved-note", System: true, Status: chat.Completed, Steps: []turnStep{{ID: "saved-summary", Note: "压缩完成"}}},
		}
		a.historyFromPi(s, history, nil)
		turns := s.turns.GetUntracked()
		if len(turns) != 2 || turns[1].ID != "restored" || !turns[1].running() || !turns[1].End.IsZero() || !turns[0].System {
			t.Errorf("history load lost the active run or reopened it twice: %+v", turns)
		}
		// An idle handshake must not clear a locally accepted prompt that
		// is waiting to be released by historyReady.
		s.live = false
		a.engineReady(s, nil, nil, "", "", 2, false)
		if !s.busyNow() || !s.turns.GetUntracked()[len(s.turns.GetUntracked())-1].running() {
			t.Error("idle handshake cleared an accepted prompt")
		}
	})
	screen.WaitFor("id:composer-stop", 5*time.Second)
}

func TestPiDelegateNoticeSettlesWithoutStartingIdleRun(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	onNativeUI(t, screen, a, func() {
		run := toolRun{CallID: "background", Name: "acp_delegate", Action: "子代理", Status: chat.Completed, Output: "Dispatched runId `del_1`"}
		s.turns.Set([]turn{{ID: "source", Status: chat.Completed, Steps: []turnStep{{ID: "calls", Tools: []toolRun{run}}}}})
		a.applyEvent(s, piEvent{Type: "message_end", Message: json.RawMessage(`{"role":"custom","content":"[acp_delegate completed] runId ` + "`del_1`" + `"}`)})
		entries := delegations(s.turns.GetUntracked(), []toolRun{run})
		if len(entries) != 1 || entries[0].state != "已完成" || s.busyNow() {
			t.Errorf("completion notice left an idle session busy: entries=%+v busy=%v", entries, s.busyNow())
		}
	})
}

func TestPiTaskNotificationKeepsCurrentPrompt(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(fmt.Sprint(active), func(t *testing.T) {
			a, screen, s := startNativeSurfaceApp(t)
			onNativeUI(t, screen, a, func() {
				status := chat.Completed
				if active {
					status = chat.Running
				}
				s.turns.Set([]turn{{ID: "original-task", Prompt: "保留当前任务", Status: status, Steps: []turnStep{{Tools: []toolRun{
					{CallID: "dispatch", Name: "Agent", Action: "子代理", Status: chat.Completed,
						Output: "Agent started in background.\nAgent ID: child-run"},
				}}}}})
				s.runningSig.Set(active)
				message, err := json.Marshal(piMessage{Role: "custom", Content: json.RawMessage(`"<task-notification><task-id>child-run</task-id><status>failed</status><result>fixture failure</result></task-notification>"`)})
				if err != nil {
					t.Error(err)
					return
				}
				a.applyEvent(s, piEvent{Type: "message_end", Message: message})
				entries := delegations(s.turns.GetUntracked(), nil)
				if len(entries) != 1 || entries[0].state != "失败" || s.busyNow() != active {
					t.Errorf("task notification changed the parent run: entries=%+v busy=%v", entries, s.busyNow())
				}
				turns := s.turns.GetUntracked()
				if turns[0].Prompt != "保留当前任务" || (active && len(turns) != 1) {
					t.Errorf("notification replaced the current task or created another run: %+v", turns)
				}
				if !active && (len(turns) != 2 || turns[1].Status != chat.Failed || !turns[1].System) {
					t.Errorf("idle failure notice did not keep its terminal state: %+v", turns)
				}
			})
		})
	}
}

func TestPiCancelledRunSettlesPendingDelegations(t *testing.T) {
	for _, closeAgent := range []bool{false, true} {
		t.Run(fmt.Sprint(closeAgent), func(t *testing.T) {
			a, screen, s := startNativeSurfaceApp(t)
			onNativeUI(t, screen, a, func() {
				s.turns.Set([]turn{{ID: "cancel-source", Status: chat.Running, Steps: []turnStep{{ID: "call", Tools: []toolRun{
					{CallID: "pending", Action: "子代理", Status: chat.Running},
				}}}}})
				s.runningSig.Set(true)
				if closeAgent {
					a.cancelPiTurn(s)
				} else {
					a.applyEvent(s, piEvent{Type: "agent_settled", Aborted: true})
				}
				entries := delegations(s.turns.GetUntracked(), nil)
				if len(entries) != 1 || entries[0].state != "已停止" || entries[0].active() {
					t.Errorf("cancel left pending delegation active: %+v", entries)
				}
			})
		})
	}
}

func TestPiToolMessageSettlesDelegation(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	onNativeUI(t, screen, a, func() {
		s.turns.Set([]turn{{ID: "agent-call", Status: chat.Running, Steps: []turnStep{{ID: "step", Tools: []toolRun{
			{CallID: "review", Name: "Agent", Action: "子代理", Status: chat.Running},
		}}}}})
		msg := piMessage{Role: "toolResult", ToolCallID: "review", ToolName: "Agent", Content: json.RawMessage(`"review finished"`)}
		run := toolRunFromResult(msg)
		a.applyEvent(s, piEvent{Type: "message_end", finishedTool: &run})
		entries := delegations(s.turns.GetUntracked(), nil)
		if len(entries) != 1 || entries[0].state != "已完成" {
			t.Errorf("authoritative tool result left a running delegation: %+v", entries)
		}
		msg.IsError = true
		run = toolRunFromResult(msg)
		a.applyEvent(s, piEvent{Type: "message_end", finishedTool: &run})
		entries = delegations(s.turns.GetUntracked(), nil)
		if len(entries) != 1 || entries[0].state != "失败" {
			t.Errorf("failed tool result did not settle the delegation: %+v", entries)
		}
	})
}
