//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestPromptLongTextFitsBubble(t *testing.T) {
	messages := map[string]string{
		"paragraphs": strings.Repeat("长文本需要完整显示，每一段都应留在发送气泡里。\n", 24) + "最后一段也必须可见。",
		"long-token": "https://example.com/" + strings.Repeat("long-path-without-spaces/", 40) + "message-end",
	}
	for name, message := range messages {
		t.Run(name, func(t *testing.T) {
			screen := chatTextFixture(t, message, "prompt")
			for _, width := range []core.Points{720, 320} {
				screen.Resize(width, 640)
				text := screen.Find("id:chat-prompt-text")
				if text.Text != message {
					t.Fatal("the outgoing message lost text")
				}
				assertChatTextInside(t, text.Bounds(), screen.Find("id:chat-prompt-bubble").Bounds())
				assertChatTextInside(t, screen.Find("id:chat-prompt-bubble").Bounds(), screen.Find("id:text-column").Bounds())
			}
			shot(screen, "chat-text/prompt-"+name)
		})
	}
}

func TestQueueLongTextFitsCard(t *testing.T) {
	message := strings.Repeat("引导内容包含中文、English words 和很长的链接 https://example.com/path/to/resource。\n", 8) + "排队消息的末尾。"
	screen := chatTextFixture(t, message, "queue")
	for _, width := range []core.Points{720, 320} {
		screen.Resize(width, 640)
		card := screen.Find("id:queue-panel").Bounds()
		for _, selector := range []string{"id:queue-steer", "id:queue-followup"} {
			row := screen.Find(selector)
			assertChatTextInside(t, row.Bounds(), card)
			for _, child := range row.Children {
				if child.Kind == nsgotest.KindText {
					assertChatTextInside(t, child.Bounds(), row.Bounds())
				}
			}
		}
	}
	shot(screen, "chat-text/queue-long")
}

func TestSessionLongSentText(t *testing.T) {
	a, screen, sess := chatDesignFixture(t, 0)
	message := strings.Repeat("长文本需要完整显示，每一段都应留在发送气泡里。\n", 24) + "最后一段也必须可见。"
	onNativeUI(t, screen, a, func() {
		sess.turns.Update(func(turns []turn) []turn {
			next := append([]turn(nil), turns...)
			next[0].Prompt = message
			return next
		})
	})
	screen.Resize(900, 720)
	text := screen.Find("id:chat-prompt-text")
	if text.Text != message {
		t.Fatal("the sent message lost text in the complete session")
	}
	assertChatTextInside(t, text.Bounds(), screen.Find("id:chat-prompt-bubble").Bounds())
	screen.Scroll("id:chat-transcript", -100000)
	shot(screen, "chat-text/session-long-prompt")
}

func TestSteeringPreservesFullText(t *testing.T) {
	a, s, screen, commands := remoteCommandFixture(t)
	message := strings.Repeat("引导内容必须完整保存，不能只剩标题中的前八十个字。\n", 32) + "引导正文末尾标记。"
	onNativeUI(t, screen, a, func() {
		s.turns.Set([]turn{{ID: "running", Prompt: "原始问题", Status: chat.Running}})
		a.steer(s, message, nil)
		steps := s.turns.GetUntracked()[0].Steps
		if len(steps) != 1 || steps[0].Text != message {
			t.Errorf("steering did not retain its complete body: %+v", steps)
		}
		if len(steps) == 1 && steps[0].Note != "发送引导" {
			t.Errorf("steering title contains message content: %q", steps[0].Note)
		}
	})
	var command map[string]any
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case command = <-commands:
			return true
		default:
			return false
		}
	})
	if command["type"] != "steer" || command["message"] != message {
		t.Fatal("steering changed the text sent to pi")
	}
}

func TestSteeringFullTextCanBeExpanded(t *testing.T) {
	message := strings.Repeat("引导正文的每一段都需要保留。\n", 8) + "引导正文末尾标记"
	screen := chatTextFixture(t, message, "steering")
	if len(screen.Query("text:引导正文末尾标记")) != 0 {
		t.Fatal("long steering body was not folded")
	}
	screen.Press("id:note-toggle-note")
	if len(screen.Query("text:引导正文末尾标记")) == 0 {
		t.Fatal("expanded steering body lost its last paragraph")
	}
	shot(screen, "chat-text/steering-expanded")
	screen.Press("id:note-toggle-note")
	if len(screen.Query("text:引导正文末尾标记")) != 0 {
		t.Fatal("steering body did not collapse again")
	}
}

func TestNoteLongTitleFitsCard(t *testing.T) {
	message := "发送引导：" + strings.Repeat("请保留每一项要求并完整验证", 6)
	screen := chatTextFixture(t, message, "note")
	for _, width := range []core.Points{720, 320} {
		screen.Resize(width, 640)
		card := screen.Find("id:note-card")
		assertChatTextInside(t, card.Bounds(), screen.Find("id:text-column").Bounds())
		found := false
		var visit func(*nsgotest.View)
		visit = func(view *nsgotest.View) {
			if view.Kind == nsgotest.KindText {
				assertChatTextInside(t, view.Bounds(), card.Bounds())
				found = found || view.Text == message
			}
			for _, child := range view.Children {
				visit(child)
			}
		}
		visit(card)
		if !found {
			t.Fatal("note title disappeared from its card")
		}
	}
	shot(screen, "chat-text/note-long-title")
}

func chatTextFixture(t *testing.T, message, kind string) *nsgotest.App {
	t.Helper()
	return nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a := &app{cx: cx, chatFont: core.NewSignal(cx, float64(0)), chatLine: core.NewSignal(cx, float64(0)),
			codeWrap: core.NewSignal(cx, true)}
		s := &session{ID: "text-fixture", uiSeq: core.NewSignal(cx, 0), steering: core.NewSignalFunc(cx, []string{message}, nil),
			sending: core.NewSignalFunc(cx, []queuedMessage{{ID: "held-message", Text: message}}, nil)}
		var content core.Node
		switch kind {
		case "queue":
			content = a.queuePanel(s)
		case "note", "steering":
			step := turnStep{ID: "note", Note: message}
			if kind == "steering" {
				step.Note, step.Text = "发送引导", message
			}
			content = a.noteBlock(s, func() turnStep { return step }, func() chat.Status { return chat.Completed })
		default:
			content = a.turnPrompt(s, func() turn { return turn{ID: "long-prompt", Prompt: message, Status: chat.Running} })
		}
		return core.Scroll{TestID: "text-scroll", Style: ui.FillRest, Children: []core.Node{
			core.View{TestID: "text-column", Style: core.Style{Width: core.Pct(100), Padding: core.All(16), FlexShrink: 0}, Children: []core.Node{content}},
		}}
	}, nsgotest.Size(720, 640), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
}

func assertChatTextInside(t *testing.T, inner, outer core.Bounds) {
	t.Helper()
	if inner.Size.Width <= 0 || inner.Size.Height <= 0 ||
		inner.Origin.X < outer.Origin.X-1 || inner.Origin.Y < outer.Origin.Y-1 ||
		inner.Origin.X+inner.Size.Width > outer.Origin.X+outer.Size.Width+1 ||
		inner.Origin.Y+inner.Size.Height > outer.Origin.Y+outer.Size.Height+1 {
		t.Errorf("content %v overflows container %v", inner, outer)
	}
}
