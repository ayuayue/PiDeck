//go:build !js && !android && !ios

package workbench

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestChatAuthorsHaveBalancedHierarchy(t *testing.T) {
	a, screen, sess := chatDesignFixture(t, 0)
	check := func(nameSize, avatarSize float64) {
		t.Helper()
		for _, role := range []string{"prompt", "reply"} {
			avatarView := screen.Find("id:chat-" + role + "-avatar")
			avatar := avatarView.Bounds()
			if len(avatarView.Children) != 1 {
				t.Fatalf("%s avatar has %d marks, want one", role, len(avatarView.Children))
			}
			markSize := avatarSize - 8
			if role == "prompt" {
				markSize = avatarSize - 14
			}
			mark := avatarView.Children[0].Bounds()
			if math.Abs(float64(mark.Size.Width)-markSize) > 0.5 || math.Abs(float64(mark.Size.Height)-markSize) > 0.5 {
				t.Errorf("%s mark = %v, want %.0f points square", role, mark, markSize)
			}
			if math.Abs(float64(avatar.Size.Width)-avatarSize) > 0.5 || math.Abs(float64(avatar.Size.Height)-avatarSize) > 0.5 {
				t.Errorf("%s avatar = %v, want %.0f points square", role, avatar, avatarSize)
			}
			name := screen.Find("id:chat-" + role + "-author")
			if got := name.TextStyle.Font.Size; math.Abs(float64(got)-nameSize) > 0.1 {
				t.Errorf("%s author font = %v, want %.0f", role, got, nameSize)
			}
			stamp := screen.Find("id:chat-" + role + "-time")
			if got := stamp.TextStyle.Font.Size; got < 12 {
				t.Errorf("%s timestamp font = %v, want at least 12", role, got)
			}
			header := screen.Find("id:chat-" + role + "-header").Bounds()
			for _, item := range []string{"avatar", "author", "time"} {
				bounds := screen.Find("id:chat-" + role + "-" + item).Bounds()
				if bounds.Size.Width <= 0 || bounds.Origin.X < header.Origin.X-1 || bounds.Origin.X+bounds.Size.Width > header.Origin.X+header.Size.Width+1 {
					t.Errorf("%s %s %v overflows its header %v", role, item, bounds, header)
				}
			}
			authorBounds, stampBounds := name.Bounds(), stamp.Bounds()
			if role == "reply" && authorBounds.Origin.X+authorBounds.Size.Width > stampBounds.Origin.X {
				t.Errorf("AI author %v overlaps timestamp %v", authorBounds, stampBounds)
			}
		}
		bubble := screen.Find("id:chat-prompt-bubble").Bounds()
		promptHeader := screen.Find("id:chat-prompt-header").Bounds()
		if promptHeader.Origin.Y+promptHeader.Size.Height > bubble.Origin.Y+1 {
			t.Errorf("user identity %v overlaps its message %v", promptHeader, bubble)
		}
		column := screen.Find("id:transcript-column").Bounds()
		if math.Abs(float64(bubble.Origin.X+bubble.Size.Width-column.Origin.X-column.Size.Width)) > 1 {
			t.Errorf("user bubble %v is not aligned to the right of %v", bubble, column)
		}
		if got := screen.Find("id:chat-reply-header").Bounds().Origin.X; math.Abs(float64(got-column.Origin.X)) > 1 {
			t.Errorf("AI header x=%v, want the reading column's left x=%v", got, column.Origin.X)
		}
	}
	screen.WaitFor("id:chat-prompt-avatar", 5*time.Second)
	check(15, 32)
	shot(screen, "chat-authors/light")

	onNativeUI(t, screen, a, func() { a.theme.Set("dark"); a.applyTheme() })
	check(15, 32)
	shot(screen, "chat-authors/dark")
	screen.Resize(900, 760)
	if offset := screen.Find("id:chat-transcript").Offset.Y; offset > 0.5 {
		screen.Scroll("id:chat-transcript", -offset)
	}
	check(15, 32)
	shot(screen, "chat-authors/narrow-dark")

	onNativeUI(t, screen, a, func() { a.cfg.ChatFont = 20; a.chatFont.Set(20) })
	if offset := screen.Find("id:chat-transcript").Offset.Y; offset > 0.5 {
		screen.Scroll("id:chat-transcript", -offset)
	}
	check(19, 40)
	shot(screen, "chat-authors/large-dark")

	// Long custom names must yield to the timestamp, and a long user
	// message must wrap without changing which side sent it.
	dir := filepath.Join(a.st.dir, "acp")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	name := strings.Repeat("Custom Agent ", 8)
	if err := os.WriteFile(filepath.Join(dir, "presets.json"), []byte(`{"presets":[{"id":"author-fixture","name":"`+name+`","command":"unused"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	onNativeUI(t, screen, a, func() { sess.turns.Set(nil) })
	screen.WaitForGone("id:chat-reply-header", 5*time.Second)
	onNativeUI(t, screen, a, func() {
		sess.backend, sess.acpPreset = "acp", "author-fixture"
		now := a.cx.Now()
		sess.turns.Set([]turn{{ID: "long-author", Prompt: strings.Repeat("长消息仍然在用户一侧自然换行。", 8), Final: "答案在这里。",
			Status: chat.Completed, Start: now.Add(-time.Minute), End: now}})
	})
	screen.WaitFor("id:chat-reply-header >> text:Custom Agent", 5*time.Second)
	check(19, 40)
	shot(screen, "chat-authors/long-agent-dark")
}

func TestChatAuthorHeaderFollowsCompletion(t *testing.T) {
	a, screen, sess := startNativeSurfaceApp(t)
	onNativeUI(t, screen, a, func() {
		sess.turns.Set([]turn{{ID: "streaming-author", Prompt: "问一句", Status: chat.Running}})
	})
	screen.WaitFor("id:chat-reply-author", 5*time.Second)
	if len(screen.Query("id:chat-prompt-time")) != 0 || len(screen.Query("id:chat-reply-time")) != 0 {
		t.Error("unknown message times should stay hidden")
	}
	onNativeUI(t, screen, a, func() {
		sess.turns.Update(func(turns []turn) []turn {
			next := append([]turn(nil), turns...)
			next[0].Final, next[0].Status, next[0].End = "答案在这里。", chat.Completed, a.cx.Now()
			return next
		})
	})
	screen.WaitFor("id:chat-reply-time", 5*time.Second)
	screen.WaitFor("id:chat-reply-header >> text:pi", 5*time.Second)
	if len(screen.Query("id:chat-prompt-time")) != 0 {
		t.Error("completing a reply should not invent a send time")
	}
}
