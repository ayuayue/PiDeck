//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func replyContentFixture(t *testing.T) (*app, *nsgotest.App, *session) {
	t.Helper()
	a, screen, s := chatDesignFixture(t, 0)
	screen.Post(func() {
		s.turns.Set([]turn{{ID: "complete-reply", Prompt: "Only this question", Status: chat.Completed, Tools: 1,
			Steps: []turnStep{{ID: "reply-step", Text: "First part of the answer", Thinking: "Reasoning for the task",
				Tools: []toolRun{{CallID: "reply-call", Name: "read", Action: "读取", Detail: "notes.md",
					Output: "Tool output for the task", Status: chat.Completed}}}},
			Final: "Last part of the answer"}})
	})
	screen.Settle()
	return a, screen, s
}

func TestReplyKeepsAllProseVisible(t *testing.T) {
	_, screen, _ := replyContentFixture(t)
	screen.WaitFor("text:Last part of the answer", 5*time.Second)
	if !screen.Exists("text:First part of the answer") {
		t.Fatal("folding the process hid an earlier part of the answer")
	}
	if screen.Exists("text:Reasoning for the task") || screen.Exists("text:Tool output for the task") {
		t.Fatal("the folded process exposed thinking or tool output")
	}
	screen.Press("id:turn-fold")
	screen.WaitFor("text:执行过程 · 1 次思考", 5*time.Second)
	if got := len(screen.Query("text:First part of the answer")); got != 1 {
		t.Fatalf("expanding the process rendered the earlier answer %d times, want 1", got)
	}
}

func TestReplyMirroredFinalKeepsContextMenu(t *testing.T) {
	_, screen, s := replyContentFixture(t)
	screen.Post(func() {
		tt := s.turns.GetUntracked()[0]
		tt.Steps = append(append([]turnStep(nil), tt.Steps...), turnStep{ID: "mirrored-final", Text: tt.Final})
		s.turns.Set([]turn{tt})
	})
	screen.Settle()
	if got := len(screen.Query("text:Last part of the answer")); got != 1 {
		t.Fatalf("mirrored final rendered %d times, want 1", got)
	}
	screen.RightClick("id:chat-reply")
	screen.Press("id:chat-copy-reply")
	if screen.Clipboard != "First part of the answer\n\nLast part of the answer" {
		t.Fatalf("mirrored final context copied %q", screen.Clipboard)
	}
}

func TestReplyTextSegments(t *testing.T) {
	for _, tc := range []struct {
		name string
		turn turn
		want string
	}{
		{"only final", turn{Final: "answer"}, "answer"},
		{"all prose", turn{Steps: []turnStep{{Text: "one"}, {Text: "two"}}, Final: "three"}, "one\n\ntwo\n\nthree"},
		{"mirrored final", turn{Steps: []turnStep{{Text: "one"}, {Text: "two"}}, Final: "two"}, "one\n\ntwo"},
		{"system note", turn{Steps: []turnStep{{Note: "system", Text: "private note"}, {Text: "answer"}}, Final: "answer"}, "answer"},
		{"repeated prose", turn{Steps: []turnStep{{Text: "same"}, {Text: "same"}}, Final: "final"}, "same\n\nsame\n\nfinal"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := replyText(tc.turn); got != tc.want {
				t.Fatalf("replyText = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestReplyMarkdownIncludesOrderedProcess(t *testing.T) {
	tt := turn{Prompt: "excluded prompt", Steps: []turnStep{
		{Thinking: "reasoning marker", Text: "first prose marker", TextAt: 1, Tools: []toolRun{
			{Action: "read", Detail: "before marker", Output: "before output marker", Diff: "diff marker", Nested: []string{"nested marker"}, Status: chat.Completed},
			{Action: "read", Detail: "after marker", Output: "after output marker", Status: chat.Completed},
		}},
		{Note: "system note marker", Text: "note contents marker"},
		{Text: "final marker"},
	}, Final: "final marker", Err: "error marker"}
	got := replyMarkdown(tt, true)
	last := -1
	for _, part := range []string{"reasoning marker", "before marker", "before output marker", "diff marker", "nested marker", "first prose marker", "after marker", "after output marker", "system note marker", "note contents marker", "final marker", "error marker"} {
		at := strings.Index(got, part)
		if at <= last {
			t.Fatalf("%q missing or out of order in:\n%s", part, got)
		}
		last = at
	}
	if strings.Contains(got, tt.Prompt) || strings.Count(got, "final marker") != 1 {
		t.Fatalf("reply export included prompt or duplicated final:\n%s", got)
	}
}

func TestReplyCopyAllIncludesProcess(t *testing.T) {
	_, screen, _ := replyContentFixture(t)
	for _, menu := range []string{"bottom", "context"} {
		if menu == "bottom" {
			screen.Press("id:turn-copy-menu")
			screen.Press("id:turn-copy-all")
		} else {
			screen.RightClick("id:chat-reply")
			screen.Press("id:chat-copy-all")
		}
		for _, part := range []string{"First part of the answer", "Last part of the answer", "Reasoning for the task", "Tool output for the task", "notes.md"} {
			if !strings.Contains(screen.Clipboard, part) {
				t.Fatalf("%s copy-all missing %q in %q", menu, part, screen.Clipboard)
			}
		}
		if strings.Contains(screen.Clipboard, "Only this question") {
			t.Fatal("copy-all included user prompt")
		}
	}
}

func TestReplyShareAllIncludesSanitizedProcess(t *testing.T) {
	_, screen, s := replyContentFixture(t)
	screen.Post(func() {
		ts := append([]turn(nil), s.turns.GetUntracked()...)
		ts[0].Steps = append([]turnStep(nil), ts[0].Steps...)
		ts[0].Steps[0].Thinking += " API_KEY=synthetic-private-key"
		ts[0].Steps[0].Tools = append([]toolRun(nil), ts[0].Steps[0].Tools...)
		ts[0].Steps[0].Tools[0].Output += " " + s.WS
		s.turns.Set(ts)
	})
	screen.Settle()
	screen.Press("id:turn-share-menu")
	screen.Press("id:turn-share-all")
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Shares) == 1 })
	got := screen.Shares[0].Text
	for _, part := range []string{"First part of the answer", "Last part of the answer", "Reasoning for the task", "Tool output for the task", shareRedacted} {
		if !strings.Contains(got, part) {
			t.Fatalf("share-all missing %q in %q", part, got)
		}
	}
	for _, private := range []string{"synthetic-private-key", s.WS, "Only this question"} {
		if strings.Contains(got, private) {
			t.Fatalf("share-all exposed %q in %q", private, got)
		}
	}
	if !strings.Contains(s.turns.GetUntracked()[0].Steps[0].Thinking, "synthetic-private-key") {
		t.Fatal("sharing modified the source process")
	}
}

func TestReplyCopyIncludesAllProse(t *testing.T) {
	a, screen, _ := replyContentFixture(t)
	const want = "First part of the answer\n\nLast part of the answer"
	for _, action := range []string{"button", "menu", "command", "context"} {
		screen.Clipboard = "before copy"
		switch action {
		case "button":
			screen.Press("id:turn-copy")
		case "menu":
			screen.Press("id:turn-copy-menu")
			screen.Press("id:turn-copy-markdown")
		case "command":
			screen.Post(a.copyLastReply)
			screen.Settle()
		case "context":
			screen.RightClick("id:chat-reply")
			screen.Press("id:chat-copy-reply")
		}
		if screen.Clipboard != want {
			t.Errorf("%s copied %q, want all prose %q", action, screen.Clipboard, want)
		}
		if strings.Contains(screen.Clipboard, "Reasoning") || strings.Contains(screen.Clipboard, "Tool output") {
			t.Fatalf("%s included process in ordinary copy", action)
		}
	}
}
