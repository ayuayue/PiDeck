//go:build !js && !android && !ios

package workbench

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

// A finished turn keeps its process folded, its answer in sight, and its
// groups closed: reading older turns must not unfold the whole transcript.
func TestTranscriptFoldsFinishedTurns(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	now := time.Now()
	step := func(id string, tools int) turnStep {
		runs := make([]toolRun, 0, tools)
		for range tools {
			runs = append(runs, toolRun{CallID: id + "-call", Name: "read", Action: "读取",
				Detail: "readme.md", Status: chat.Completed, DurationMs: 12})
		}
		return turnStep{ID: id, Thinking: "先看看文件。", Tools: runs, Start: now}
	}
	turns := []turn{
		{ID: "fold-1", Prompt: "第一轮", Status: chat.Completed, Model: "fixture/model", Start: now.Add(-90 * time.Second),
			End: now.Add(-60 * time.Second), Steps: []turnStep{step("fold-1-s0", 2)}, Tools: 2, Final: "第一轮的结论"},
		{ID: "fold-2", Prompt: "第二轮", Status: chat.Completed, Model: "fixture/model", Start: now.Add(-50 * time.Second),
			End: now.Add(-20 * time.Second), Steps: []turnStep{step("fold-2-s0", 1)}, Tools: 1, Final: "第二轮的结论"},
	}
	onNativeUI(t, screen, built, func() {
		sess.loaded.Set(true)
		sess.readySig.Set(true)
		sess.turns.Set(turns)
	})
	screen.WaitFor("text:第一轮的结论", 5*time.Second)
	screen.WaitFor("text:第二轮的结论", 5*time.Second)

	// Both finished turns fold their process and keep only the summary.
	if got := len(screen.Query("text:执行过程 · 2 个工具调用 · 思考")); got != 0 {
		t.Fatalf("the folded process is on screen: %d groups mounted", got)
	}
	screen.Press("text:2 个工具调用")
	screen.WaitFor("text:执行过程 · 2 个工具调用 · 思考", 5*time.Second)
	if screen.Exists("text:readme.md") {
		t.Fatalf("a closed process group shows its rows: %d", len(screen.Query("text:readme.md")))
	}
	screen.Press("text:执行过程 · 2 个工具调用 · 思考")
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("label:读取 readme.md")) == 2 })
	shot(screen, "comparison/session-turn-fold")

	// Scrolling up keeps the other turn folded, as PiDeck's does.
	onNativeUI(t, screen, built, func() {
		sess.conversation.following.Set(false)
	})
	screen.Settle()
	if !screen.Exists("text:2 个工具调用") || !screen.Exists("text:1 个工具调用") {
		t.Fatal("a completed turn lost its fold row while scrolling")
	}
	if screen.Exists("text:执行过程 · 1 个工具调用 · 思考") {
		t.Fatal("scrolling up unfolded a closed process group")
	}
}
