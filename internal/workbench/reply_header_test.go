//go:build !js && !android && !ios

package workbench

// Checks the line above a reply: who answered it and when, with the time
// out of the tail where the duration and the model stayed.

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

// TestReplyHeaderNamesItsAuthor checks a pi reply names pi and carries the
// reply's time, and that the tail keeps the duration and the model.
func TestReplyHeaderNamesItsAuthor(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	now := built.cx.Now()
	onNativeUI(t, screen, built, func() {
		sess.turns.Set([]turn{{ID: "h0", Prompt: "问一句", Final: "答案在这里。", Status: chat.Completed,
			Model: "claude-sonnet-4", Start: now.Add(-7 * time.Minute), End: now}})
	})
	screen.WaitFor("id:chat-reply-header", 5*time.Second)
	screen.WaitFor("id:chat-reply-header >> text:pi", 5*time.Second)
	screen.WaitFor("id:chat-reply-header >> text:"+clockTime(now), 5*time.Second)
	if got := len(screen.Query("text:" + clockTime(now))); got != 1 {
		t.Errorf("the reply's time shows %d times, want once above the reply", got)
	}
	screen.WaitFor("text:7m00s", 5*time.Second)
	screen.WaitFor("text:claude-sonnet-4", 5*time.Second)
}

// TestReplyHeaderNamesTheACPAgent checks an ACP reply names its preset.
func TestReplyHeaderNamesTheACPAgent(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	now := built.cx.Now()
	onNativeUI(t, screen, built, func() {
		sess.backend = "acp"
		sess.acpPreset = "claude"
		sess.turns.Set([]turn{{ID: "h0", Prompt: "问一句", Final: "答案在这里。", Status: chat.Completed,
			Start: now.Add(-time.Minute), End: now}})
	})
	screen.WaitFor("id:chat-reply-header", 5*time.Second)
	screen.WaitFor("id:chat-reply-header >> text:Claude Agent", 5*time.Second)
}

// TestSystemNoteHasNoReplyHeader checks a compaction note is not dressed as
// an answer.
func TestSystemNoteHasNoReplyHeader(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	onNativeUI(t, screen, built, func() {
		sess.turns.Set(nil)
		built.addNote(sess, "compaction", "上下文已压缩", "摘要", chat.Completed)
	})
	onNativeUI(t, screen, built, func() {
		turns := sess.turns.GetUntracked()
		if len(turns) != 1 || !turns[0].System {
			t.Fatalf("note turn = %+v, want one system turn", turns)
		}
	})
	screen.Settle()
	if got := len(screen.Query("id:chat-reply-header")); got != 0 {
		t.Errorf("a system note shows %d reply headers", got)
	}
}
