package client

// The two folds a reader has to open on the phone: a finished turn's process,
// and then the thinking block inside it. Both are taps that land on a page the
// poll keeps refreshing, so both are also where a swallowed press showed up.

import (
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
)

// longThought is one reasoning block past a phone screen's worth, so the
// folded line and the opened block are told apart by their words.
func longThought() string {
	var b strings.Builder
	for i := 0; i < 30; i++ {
		b.WriteString("第")
		b.WriteString(strings.Repeat("一", 1+i%3))
		b.WriteString("段推理：先看清工作区，再动接口。")
	}
	b.WriteString("收尾这一句只在展开后才看得到。")
	return b.String()
}

func foldedTranscript() remotewire.Transcript {
	return remotewire.Transcript{ID: "s1", Title: "折叠的会话", Messages: []remotewire.Message{
		{Role: "user", Text: "改一下接口", Turn: 0},
		{Role: "thinking", Text: longThought(), Turn: 0},
		{Role: "tool", Text: "运行 git status", Turn: 0, Tool: &remotewire.ToolLine{
			Name: "bash", Action: "运行", Detail: "git status", Status: "done",
			DurationMs: 120, Output: "On branch main"}},
		{Role: "assistant", Text: "接口改好了。", Turn: 0},
	}}
}

// TestMobileFoldedProcessOpensItsThinking walks the path a reader takes on a
// finished turn: the process row, then the thinking inside it.
func TestMobileFoldedProcessOpensItsThinking(t *testing.T) {
	app, _ := liveTranscriptDesktop(t, foldedTranscript)
	waitApp(app, "text:接口改好了。", 15*time.Second)
	app.WaitFor("id:mobile-process", 10*time.Second)
	if len(app.Query("id:mobile-thought")) != 0 {
		t.Fatal("a finished turn showed its thinking before the process was opened")
	}

	app.Press("id:mobile-process")
	app.WaitFor("id:mobile-thought", 5*time.Second)
	// Still folded: only the first line of the reasoning shows, so its last
	// words are not on the page.
	if len(app.Query("text:收尾这一句只在展开后才看得到。")) != 0 {
		t.Fatal("the thinking block was already open")
	}

	app.Press("id:mobile-thought")
	waitApp(app, "text:收尾这一句只在展开后才看得到。", 5*time.Second)
}

// TestMobileTapSurvivesAPoll keeps the fold a reader opened across the polls
// that follow: a page rebuilt every second or two swallows the tap and closes
// the block under the finger.
func TestMobileTapSurvivesAPoll(t *testing.T) {
	app, _ := liveTranscriptDesktop(t, foldedTranscript)
	waitApp(app, "text:接口改好了。", 15*time.Second)
	app.WaitFor("id:mobile-process", 10*time.Second)
	app.Press("id:mobile-process")
	app.WaitFor("id:mobile-thought", 5*time.Second)
	app.Press("id:mobile-thought")
	waitApp(app, "text:收尾这一句只在展开后才看得到。", 5*time.Second)

	// Two idle polls later the block is still open: the same page came back,
	// so nothing was redrawn under the reader.
	for i := 0; i < 2; i++ {
		app.FastForward(2600 * time.Millisecond)
		app.Settle()
	}
	if len(app.Query("text:收尾这一句只在展开后才看得到。")) == 0 {
		t.Fatal("a poll closed the block the reader opened")
	}
}
