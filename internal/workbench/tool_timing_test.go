//go:build !js && !android && !ios

package workbench

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestACPToolRecordsLocalDuration(t *testing.T) {
	built, screen, s := newAskApp(t)
	onNativeUI(t, screen, built, func() {
		s.acpTurnID = "timed-acp"
		s.turns.Set([]turn{{ID: s.acpTurnID, Status: chat.Running}})
		built.updateACPTool(s, acpToolRun(acpUpdate{ToolID: "call", ToolName: "read", ToolKind: "read"}, chat.Running), true)
	})
	current := func() toolRun {
		t.Helper()
		turns := s.turns.GetUntracked()
		if len(turns) != 1 || len(turns[0].Steps) != 1 || len(turns[0].Steps[0].Tools) != 1 {
			t.Fatalf("expected one ACP call, got %+v", turns)
		}
		return turns[0].Steps[0].Tools[0]
	}
	run := current()
	if run.Start.IsZero() {
		t.Fatalf("ACP call has no local start: %+v", run)
	}
	screen.Advance(1250 * time.Millisecond)
	onNativeUI(t, screen, built, func() {
		built.updateACPTool(s, acpToolRun(acpUpdate{ToolID: "call", Status: "completed"}, chat.Completed), false)
	})
	run = current()
	if run.DurationMs < 1250 || toolTime(run, built.cx.Now()) == "" {
		t.Fatalf("ACP call has no completed duration: %+v", run)
	}
	measured := run.DurationMs
	screen.Advance(time.Second)
	onNativeUI(t, screen, built, func() {
		built.updateACPTool(s, acpToolRun(acpUpdate{ToolID: "call", Text: "read complete"}, chat.Completed), false)
	})
	run = current()
	if run.DurationMs != measured {
		t.Fatalf("a later output changed the duration from %d to %d", measured, run.DurationMs)
	}
}

func TestProcessRowsWithoutTimingShowZero(t *testing.T) {
	for _, status := range []chat.Status{chat.Completed, chat.Failed, chat.Cancelled} {
		if got := toolTime(toolRun{Status: status}, time.Time{}); got != "0ms" {
			t.Errorf("toolTime(%v) = %q, want 0ms", status, got)
		}
	}
	src := stepSource{s: &session{}, turn: func() turn {
		return turn{Status: chat.Completed, Steps: []turnStep{{ID: "thought"}}}
	}, id: func() string { return "thought" }}
	if got := thinkTime(src.s, src, time.Time{}); got != "0ms" {
		t.Errorf("unrecorded thinking time = %q, want 0ms", got)
	}
}
