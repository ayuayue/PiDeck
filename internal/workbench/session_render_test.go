//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

// Feed the same records as pi's RPC reader so these screens do not need
// a provider or a live account. Advance the UI clock to flush deltas.
func TestSessionStreamRendersWithToolsAndErrors(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	emit := func(record string) {
		t.Helper()
		var ev piEvent
		if err := json.Unmarshal([]byte(record), &ev); err != nil {
			t.Fatal(err)
		}
		built.onPiEvent(sess, ev)
		screen.Settle()
	}
	begin := func(id, prompt string) {
		onNativeUI(t, screen, built, func() {
			sess.turns.Update(func(turns []turn) []turn {
				return append(turns, turn{ID: id, Prompt: prompt, Status: chat.Running, Start: built.cx.Now()})
			})
			sess.runningSig.Set(true)
		})
		emit(`{"type":"agent_start"}`)
		emit(`{"type":"message_start","message":{"role":"assistant"}}`)
		screen.WaitFor("label:停止", 5*time.Second)
	}
	onNativeUI(t, screen, built, func() {
		sess.turns.Set(nil)
		sess.loaded.Set(true)
		sess.readySig.Set(true)
		sess.draft.Set("")
		built.cfg.NotifyOnDone = false
	})
	shot(screen, "comparison/session-draft")
	begin("fixture-stream", "阅读示例文件")
	emit(`{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"先查看文件内容。"}}`)
	screen.Advance(80 * time.Millisecond)
	screen.WaitFor("text:先查看文件内容。", 5*time.Second)
	shot(screen, "comparison/session-thinking")
	emit(`{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"先查看文件内容。"},{"type":"toolCall","id":"tool-read","name":"read","arguments":{"path":"readme.md"}}]}}`)
	emit(`{"type":"tool_execution_start","toolName":"read","toolCallId":"tool-read","args":{"path":"readme.md"}}`)
	emit(`{"type":"tool_execution_update","toolName":"read","toolCallId":"tool-read","partialResult":{"content":[{"type":"text","text":"fixture-read-progress"}]}}`)
	screen.WaitFor("text:fixture-read-progress", 5*time.Second)
	shot(screen, "comparison/session-tool-running")
	emit(`{"type":"tool_execution_end","toolName":"read","toolCallId":"tool-read","durationMs":245,"result":{"content":[{"type":"text","text":"fixture-tool-output"}]}}`)
	emit(`{"type":"message_start","message":{"role":"assistant"}}`)
	emit(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"已经读完文件。"}}`)
	screen.Advance(80 * time.Millisecond)
	screen.WaitFor("text:已经读完文件。", 5*time.Second)
	shot(screen, "comparison/session-streaming")
	emit(`{"type":"message_end","message":{"role":"assistant","model":"fixture-chat","content":[{"type":"text","text":"已经读完文件。"}]}}`)
	emit(`{"type":"agent_settled"}`)
	screen.WaitForGone("label:停止", 5*time.Second)
	screen.WaitFor("id:chat-reply", 5*time.Second)
	screen.Press("text:1 个工具调用")
	screen.Press("text:执行过程 · 1 个工具调用 · 思考")
	screen.Press("label:读取 readme.md")
	screen.WaitFor("text:fixture-tool-output", 5*time.Second)
	shot(screen, "comparison/session-tool-complete")
	// The ring beside Send explains what the session spent and how fast it
	// answered; the fixture fills in what pi would report.
	onNativeUI(t, screen, built, func() {
		sess.stats.Set(sessionStats{Known: true, UserMessages: 3, AssistantMessages: 7, ToolCalls: 12,
			ContextTokens: 122000, ContextWindow: 272000, ContextPercent: 44.8,
			Tokens: usageInfo{Input: 128000, Output: 9000, CacheRead: 420000, CacheWrite: 33000, Total: 590000}})
		sess.usage.Set(usageInfo{Input: 128000, Output: 9000, CacheRead: 420000, CacheWrite: 33000, Total: 590000, Cost: 0.42})
		sess.perf.Set(replyPerf{TTFT: 480 * time.Millisecond, Total: 7 * time.Second, Output: 620, LastPrompt: 122000,
			HitLast: 82.4, HitSum: 312.8, HitCount: 4, HasHit: true, HasTTFT: true, HasReplySpeed: true})
	})
	screen.Press("id:context-meter")
	screen.WaitFor("id:usage-panel", 5*time.Second)
	shot(screen, "comparison/usage-panel")
	screen.Press("id:context-meter")
	screen.WaitForGone("id:usage-panel", 5*time.Second)

	begin("fixture-error", "检查错误提示")
	emit(`{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"Fixture connection failed"}}`)
	emit(`{"type":"agent_settled"}`)
	screen.WaitFor("text:Fixture connection failed", 5*time.Second)
	screen.WaitFor("label:重试", 5*time.Second)
	shot(screen, "comparison/session-error")
	begin("fixture-stop", "检查停止提示")
	emit(`{"type":"agent_settled","aborted":true}`)
	screen.WaitForGone("label:停止", 5*time.Second)
	screen.WaitFor("text:已停止", 5*time.Second)
	onNativeUI(t, screen, built, func() {
		turns := sess.turns.GetUntracked()
		if got := turns[len(turns)-1].Status; got != chat.Cancelled {
			t.Errorf("stopped turn status = %v, want cancelled", got)
		}
	})
	shot(screen, "comparison/session-stopped")
}

// TestSessionErrorDropsRetryAfterRecovery checks a failure keeps pi's error
// text but loses its retry once the session answers again: the row would
// only repeat work the transcript already shows.
func TestSessionErrorDropsRetryAfterRecovery(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	const failure = "zui: connection lost mid-reply"
	now := built.cx.Now()
	onNativeUI(t, screen, built, func() {
		sess.loaded.Set(true)
		sess.readySig.Set(true)
		sess.draft.Set("")
		sess.turns.Set([]turn{{ID: "t-failed", Prompt: "跑一遍测试", Status: chat.Failed, Err: failure,
			Start: now.Add(-time.Minute), End: now.Add(-time.Minute)}})
	})
	screen.WaitFor("text:"+failure, 5*time.Second)
	screen.WaitFor("label:重试", 5*time.Second)

	onNativeUI(t, screen, built, func() {
		sess.turns.Update(func(ts []turn) []turn {
			return append(ts, turn{ID: "t-answered", Prompt: "再来一次", Final: "测试通过了。",
				Status: chat.Completed, Start: now.Add(-time.Second), End: now})
		})
	})
	screen.WaitForGone("label:重试", 5*time.Second)
	screen.WaitFor("text:"+failure, 5*time.Second)
}

// TestRecoveredAfter checks which failures still need a retry.
func TestRecoveredAfter(t *testing.T) {
	turns := []turn{
		{ID: "a", Status: chat.Failed, Err: "boom"},
		{ID: "b", Status: chat.Cancelled},
		{ID: "c", Status: chat.Completed, Final: "answer"},
		{ID: "d", Status: chat.Failed, Err: "boom"},
	}
	cases := []struct {
		id   string
		want bool
	}{
		{"a", true},  // an answer came after it
		{"b", true},  // cancelled, then answered
		{"c", false}, // the last answer itself
		{"d", false}, // nothing after the newest failure
		{"", false},  // unknown turn
	}
	for _, c := range cases {
		if got := recoveredAfter(turns, c.id); got != c.want {
			t.Errorf("recoveredAfter(%q) = %v, want %v", c.id, got, c.want)
		}
	}
}
