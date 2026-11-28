package client

// Checks the two halves of a quiet poll: a page that came back unchanged
// draws nothing, and one that changed draws. The phone polls every second or
// two, so a redrawn page flickers and eats a tap that landed mid-rebuild.

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
)

// TestMobileUnchangedPollDrawsNothing drives the real signals with an answer
// decoded afresh, the way a poll brings it: every pointer in it is new, so
// comparing by identity would call each poll a change.
func TestMobileUnchangedPollDrawsNothing(t *testing.T) {
	app, built := liveTranscriptDesktop(t, finishedTranscript)
	waitApp(app, "text:接口改好了，测试也过了。", 15*time.Second)

	var redraws int32
	built.cx.Post(func() {
		built.cx.Effect(func() {
			_ = built.messages.Get()
			_ = built.state.Get()
			atomic.AddInt32(&redraws, 1)
		})
	})
	app.Settle()
	base := atomic.LoadInt32(&redraws)

	// The same page as the next poll brings it.
	same := redecodeTranscript(t, finishedTranscript())
	sameSnap := redecodeSnapshot(t, built.state.GetUntracked())
	built.cx.Post(func() {
		built.messages.Set(same.Messages)
		built.state.Set(sameSnap)
	})
	app.Settle()
	if got := atomic.LoadInt32(&redraws); got != base {
		t.Fatalf("an unchanged poll redrew the page %d times; want none", got-base)
	}

	// A page that did change still draws, or the quiet one would have been
	// bought by never updating.
	changed := append([]remotewire.Message(nil), same.Messages...)
	changed[len(changed)-1].Text = "接口改好了，测试也过了。再加一句。"
	built.cx.Post(func() { built.messages.Set(changed) })
	app.Settle()
	if atomic.LoadInt32(&redraws) == base {
		t.Fatal("a changed page did not redraw")
	}
}

// TestMobileHeaderMarkWaitsForASlowRead keeps the spinner off the page's own
// polling: a read that lands in tens of milliseconds says nothing, and a mark
// that followed every one of them twitched at the top of the page every
// second or two.
func TestMobileHeaderMarkWaitsForASlowRead(t *testing.T) {
	app, built := liveTranscriptDesktop(t, finishedTranscript)
	waitApp(app, "text:接口改好了，测试也过了。", 15*time.Second)
	// Stop the page's own polling so this reads only the mark.
	built.cx.Post(func() { built.connected.Set(false) })
	app.Settle()

	built.cx.Post(func() { built.refreshing.Set(true) })
	app.Advance(busyMarkDelay - 100*time.Millisecond)
	if built.busyMark.GetUntracked() {
		t.Fatal("a read that was still quick showed the mark")
	}

	app.Advance(200 * time.Millisecond)
	if !built.busyMark.GetUntracked() {
		t.Fatal("a read past the delay showed no mark")
	}

	built.cx.Post(func() { built.refreshing.Set(false) })
	app.Settle()
	if built.busyMark.GetUntracked() {
		t.Fatal("the mark stayed after the read ended")
	}
}

// redecodeTranscript re-reads an answer through JSON, as the poll does.
func redecodeTranscript(t *testing.T, in remotewire.Transcript) remotewire.Transcript {
	t.Helper()
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out remotewire.Transcript
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// redecodeSnapshot is redecodeTranscript for the desktop's project list.
func redecodeSnapshot(t *testing.T, in remotewire.Snapshot) remotewire.Snapshot {
	t.Helper()
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out remotewire.Snapshot
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
