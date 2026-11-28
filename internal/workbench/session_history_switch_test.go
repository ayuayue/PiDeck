//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"strings"
	"testing"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestReopeningExpandedHistoryWithoutSearchSettles(t *testing.T) {
	a, screen, existing := startNativeSurfaceApp(t)
	var history *session
	onNativeUI(t, screen, a, func() {
		ws := a.workspaceFor(existing.Target, existing.WS)
		history = a.blankSession("long-history", ws, "长历史会话")
		var turns []turn
		for i := range 144 {
			turns = append(turns, turn{
				ID: fmt.Sprintf("history-%d", i), Prompt: fmt.Sprintf("历史提问 %d", i),
				Final:  strings.Repeat("历史回复中的一段正文。\n\n", 128) + fmt.Sprintf("历史回复结尾 %d。", i),
				Status: chat.Completed,
			})
		}
		history.turns.Set(turns)
		// Reopening retains the range the reader previously expanded with
		// Load Earlier; it must not eagerly register every paragraph for find.
		history.window.Set(len(turns))
		ws.Sessions.Set([]*session{history, existing})
	})
	open := func() {
		t.Helper()
		screen.Press("id:session-row >> nth=0")
		screen.FindMounted("text:历史回复结尾 143。")
		if got := a.activeID.GetUntracked(); got != history.ID {
			t.Fatalf("active session = %q, want %q", got, history.ID)
		}
		if history.hasAgent() {
			t.Fatal("opening history started an agent")
		}
		if got := len(history.turns.GetUntracked()); got != 144 {
			t.Fatalf("history contains %d turns, want 144", got)
		}
	}
	open()
	screen.Press("id:session-row >> nth=1")
	open()
}
