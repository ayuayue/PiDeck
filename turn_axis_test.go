package main

// Checks the transcript's right-edge ruler: how it samples a long
// conversation, and a click jumping back to the start.

import (
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestAxisTicks(t *testing.T) {
	if got := axisTicks(0); len(got) != 0 {
		t.Fatalf("no turns made %d ticks", len(got))
	}
	if got := axisTicks(3); len(got) != 3 || got[0] != 0 || got[2] != 2 {
		t.Fatalf("three turns made %v", got)
	}
	got := axisTicks(100)
	if len(got) != 24 || got[0] != 0 || got[23] != 99 {
		t.Fatalf("a hundred turns made %d ticks from %d to %d", len(got), got[0], got[len(got)-1])
	}
	for i := 1; i < len(got); i++ {
		if got[i] <= got[i-1] {
			t.Fatalf("ticks are not ascending: %v", got)
		}
	}
}

func TestTurnAxis(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := fakeACPApp(t)
	newFakeACPSession(t, app)
	app.WaitFor("text:hello", 10*time.Second)
	for i := 0; i < 7; i++ {
		app.Type("id:composer", "hi")
		app.Press("role:button 发送")
		want := i + 2
		app.WaitUntil(15*time.Second, func() bool { return len(app.Query("text:hello")) >= want })
	}
	app.WaitFor("id:turn-tick-0", 5*time.Second)
	app.Press("id:turn-tick-0")
	app.WaitFor("label:跳到最新消息", 5*time.Second)
}
