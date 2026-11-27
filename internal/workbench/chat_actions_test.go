//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"image/png"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestChatMessageActions(t *testing.T) {
	_, screen, s := chatDesignFixture(t, 0)
	for _, id := range []string{"prompt-copy", "prompt-edit", "prompt-delete", "prompt-restore", "prompt-fork", "turn-copy", "turn-copy-menu", "turn-share"} {
		screen.Find("id:" + id)
	}
	for _, id := range []string{"turn-edit-prompt", "turn-delete", "turn-favorite", "turn-retry", "turn-fork", "reply-action-strip"} {
		if len(screen.Query("id:"+id)) != 0 {
			t.Errorf("reply still offers %s", id)
		}
	}
	screen.Press("id:prompt-copy")
	if screen.Clipboard != s.turns.GetUntracked()[0].Prompt {
		t.Fatalf("copied prompt = %q", screen.Clipboard)
	}
	screen.Post(func() { s.draft.Set("unfinished draft") })
	screen.Press("id:prompt-restore")
	if s.draft.GetUntracked() != "unfinished draft" {
		t.Fatal("restoring a prompt replaced the unsent draft")
	}
	screen.Press("id:draft-change-apply")
	if s.draft.GetUntracked() != s.turns.GetUntracked()[0].Prompt {
		t.Fatalf("restored prompt = %q", s.draft.GetUntracked())
	}
	screen.Press("id:draft-change-undo")
	if s.draft.GetUntracked() != "unfinished draft" {
		t.Fatal("restoring a prompt could not be undone")
	}
}

func TestReplyShortcutsStayInContextMenu(t *testing.T) {
	a, screen, _ := chatDesignFixture(t, 0)
	screen.WaitUntil(5*time.Second, func() bool { return !a.quickReplies.loading.GetUntracked() })
	data, err := prepareReplyShortcuts(replyShortcuts{Version: 1, ReplyActions: []replyActionRule{
		{Text: "Follow up", Triggers: []replyActionTrigger{{Kind: "onStop"}}},
	}}, true)
	if err != nil {
		t.Fatal(err)
	}
	screen.Post(func() { a.quickReplies.data.Set(data) })
	screen.Settle()
	if len(screen.Query("id:reply-action-Follow up")) != 0 {
		t.Fatal("reply shortcut is visible outside the context menu")
	}
	screen.RightClick("id:chat-reply")
	screen.WaitFor("id:reply-action-Follow up", 5*time.Second)
	screen.Key("escape")
}

func TestReplyCopyFormatsFollowCurrentAnswer(t *testing.T) {
	_, screen, s := chatDesignFixture(t, 0)
	const answer = "## Updated answer\n\n**Keep Markdown** and `code`."
	screen.Post(func() {
		s.turns.Update(func(turns []turn) []turn {
			out := append([]turn(nil), turns...)
			out[0].Final = answer
			return out
		})
	})
	screen.Settle()
	screen.Press("id:turn-copy")
	if screen.Clipboard != answer {
		t.Fatalf("direct copy = %q, want current Markdown %q", screen.Clipboard, answer)
	}
	screen.Clipboard = "before dropdown"
	screen.Press("id:turn-copy-menu")
	screen.WaitFor("id:turn-copy-markdown", 5*time.Second)
	screen.Find("id:turn-copy-image")
	screen.Press("id:turn-copy-markdown")
	if screen.Clipboard != answer {
		t.Fatalf("Markdown copy = %q, want %q", screen.Clipboard, answer)
	}
	// A headless host cannot provide rendered pixels. Failure must leave
	// the clipboard intact rather than silently copying text as an image.
	if len(screen.ClipboardImage) == 0 {
		screen.Press("id:turn-copy-menu")
		screen.Press("id:turn-copy-image")
		screen.WaitUntil(5*time.Second, func() bool {
			return len(screen.ClipboardImage) > 0 || strings.Contains(screen.Dump(), "操作失败")
		})
		if screen.Clipboard != answer && len(screen.ClipboardImage) == 0 {
			t.Fatal("failed image copy changed the clipboard")
		}
	}
}

func TestNativeReplyImageCopy(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native capture requires rendered pixels")
	}
	_, screen, _ := chatDesignFixture(t, 0)
	screen.Press("id:turn-copy-menu")
	screen.Press("id:turn-copy-image")
	screen.WaitUntil(5*time.Second, func() bool {
		return len(screen.ClipboardImage) > 0 || strings.Contains(screen.Dump(), "操作失败")
	})
	image, err := png.DecodeConfig(bytes.NewReader(screen.ClipboardImage))
	if err != nil {
		t.Fatalf("copied reply is not a PNG: %v", err)
	}
	window := screen.Capture().Bounds()
	if image.Width <= 0 || image.Height <= 0 || image.Width >= window.Dx() || image.Height >= window.Dy() {
		t.Fatalf("reply image has unexpected dimensions: %dx%d (window %dx%d)", image.Width, image.Height, window.Dx(), window.Dy())
	}
	screen.Screenshot("message-actions/reply-copy")
}

func TestReplyShareOnlySelectedAnswer(t *testing.T) {
	_, screen, s := chatDesignFixture(t, 0)
	const answer = "The result is ready."
	screen.Post(func() {
		s.window.Set(1)
		s.turns.Set([]turn{
			{ID: "older", Prompt: "unrelated question", Final: "unrelated answer", Status: chat.Completed},
			{ID: "selected", Prompt: "private prompt", Final: answer + " API_KEY=private-value-1234567890",
				Steps: []turnStep{{Thinking: "private thinking", Text: "intermediate reply"}}, Status: chat.Completed},
		})
	})
	screen.Settle()
	screen.Press("id:turn-share")
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Shares) == 1 })
	shared := screen.Shares[0]
	if shared.Text != "intermediate reply\n\n"+answer+" API_KEY="+shareRedacted || len(shared.Files) != 0 {
		t.Fatalf("shared reply = %+v", shared)
	}
	if s.turns.GetUntracked()[1].Final != answer+" API_KEY=private-value-1234567890" {
		t.Fatal("sharing changed the source answer")
	}
}
