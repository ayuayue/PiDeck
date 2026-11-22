//go:build !js && !android && !ios

package workbench

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"

	"example.com/pideck-lite/internal/apptext"
)

func TestChatStartKeepsComposerAcrossFirstTurn(t *testing.T) {
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	a, screen, s := chatDesignFixture(t, 0)
	screen.Post(func() { s.turns.Set(nil) })
	screen.WaitFor("id:empty-chat-logo", 5*time.Second)
	shot(screen, "chat-start/light")

	const input = "id:composer"
	const card = "id:composer-card"
	const draft = "先看看当前目录里有什么，用一句话概括它是做什么的。"
	const suggestions = "id:chat-starter-prompts"
	before := screen.Find(input)
	startCard := screen.Find(card).Bounds()
	if prompts := screen.Find(suggestions).Bounds(); prompts.Origin.Y+prompts.Size.Height > startCard.Origin.Y {
		t.Errorf("starter prompts %v should sit above the composer card %v", prompts, startCard)
	}
	viewport := screen.Find("id:transcript").Bounds()
	if center := startCard.Origin.Y + startCard.Size.Height/2 - viewport.Origin.Y; center < viewport.Size.Height/3 || center > viewport.Size.Height*2/3 {
		t.Fatalf("the start composer %v should occupy the middle of %v", startCard, viewport)
	}
	screen.Focus("id:chat-starter-overview")
	screen.Key("Return")
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find(input).Text == draft })
	if !screen.Find(input).Focused {
		t.Fatal("choosing a starter prompt should focus the composer")
	}
	screen.WaitForGone("id:chat-starter-overview", 5*time.Second)
	if got := screen.Find(card).Bounds(); got != startCard {
		t.Errorf("typing a starter prompt moved the card from %v to %v", startCard, got)
	}

	screen.Post(func() {
		if len(s.turns.GetUntracked()) != 0 {
			t.Error("choosing a starter prompt must not send it")
		}
		s.turns.Set([]turn{{ID: "first", Prompt: "第一条消息", Final: "第一条回复", Status: chat.Completed}})
	})
	screen.WaitFor("text:第一条回复", 5*time.Second)
	screen.WaitForGone("id:empty-chat-logo", 5*time.Second)
	after := screen.Find(input)
	if after.ID != before.ID || !after.Focused || after.Text != draft {
		t.Errorf("first turn changed the composer: node = %v, focused = %v, draft = %q", after.ID, after.Focused, after.Text)
	}
	if got := screen.Find(card).Bounds(); got.Origin.Y <= startCard.Origin.Y+64 {
		t.Errorf("composer stayed near the middle with a transcript: %v", got)
	}
	if !columnsMatchPercent(screen, 80) {
		t.Error("the docked composer and timeline should still share the configured width")
	}

	screen.Post(func() {
		s.turns.Set(nil)
		s.draft.Set("")
		a.theme.Set("dark")
		a.applyTheme()
	})
	screen.WaitFor(suggestions, 5*time.Second)
	shot(screen, "chat-start/dark")
	screen.Post(func() { a.setLanguage("fr-FR") })
	screen.Resize(760, 620)
	screen.WaitFor(suggestions, 5*time.Second)
	row := screen.Find(suggestions).Bounds()
	viewport = screen.Find("id:transcript").Bounds()
	for _, id := range []string{"overview", "tests", "explain", "fix"} {
		b := screen.Find("id:chat-starter-" + id).Bounds()
		if b.Origin.X < row.Origin.X-1 || b.Origin.X+b.Size.Width > row.Origin.X+row.Size.Width+1 ||
			b.Origin.Y+b.Size.Height > viewport.Origin.Y+viewport.Size.Height+1 {
			t.Errorf("%s button %v does not fit within the start surface %v", id, b, viewport)
		}
	}
	shot(screen, "chat-start/narrow-french-dark")
	screen.Press("id:chat-starter-tests")
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find(input).Text != "" })
}
