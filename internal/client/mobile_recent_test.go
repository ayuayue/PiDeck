package client

// Keeps the rail's session list readable: a project shows the last few
// days by default, and the rest waits behind one row that opens.

import (
	"testing"
	"time"

	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestSplitRecentSessions pins what the rail keeps in sight: the last few
// days, and anything the user is watching, whatever its age.
func TestSplitRecentSessions(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.Local)
	at := func(days int) int64 { return now.AddDate(0, 0, -days).UnixMilli() }
	list := []remotewire.Session{
		{ID: "today", Title: "今天的", Updated: at(0)},
		{ID: "edge", Title: "刚好在窗口里", Updated: at(sessionRecentDays)},
		{ID: "old", Title: "十几天前的", Updated: at(10)},
		{ID: "pinned", Title: "置顶的旧会话", Updated: at(30), Pinned: true},
		{ID: "running", Title: "在跑的旧会话", Updated: at(30), Running: true},
		{ID: "asked", Title: "等回答的旧会话", Updated: at(30), Ask: &remotewire.Ask{Method: "confirm"}},
		{ID: "unknown", Title: "时间不明的", Updated: 0},
	}
	recent, earlier := splitRecentSessions(list, now)
	kept := make(map[string]bool, len(recent))
	for _, s := range recent {
		kept[s.ID] = true
	}
	for _, want := range []string{"today", "edge", "pinned", "running", "asked", "unknown"} {
		if !kept[want] {
			t.Errorf("%q folded away, want it shown by default", want)
		}
	}
	if len(earlier) != 1 || earlier[0].ID != "old" {
		t.Fatalf("earlier = %+v, want only the ten-day-old session", earlier)
	}
}

// TestMobileRailFoldsOlderSessions drives the row that opens and closes a
// project's older sessions.
func TestMobileRailFoldsOlderSessions(t *testing.T) {
	desk := newComposerDesktop(t,
		remotewire.Session{ID: "s1", Title: "今天的会话", Status: "idle", Updated: time.Now().UnixMilli()},
		remotewire.Session{ID: "s2", Title: "很久以前的会话", Status: "idle",
			Updated: time.Now().AddDate(0, 0, -10).UnixMilli()},
	)
	var app *nsgotest.App
	desk.open(t, &app)

	waitApp(app, "id:mobile-session", 10*time.Second)
	app.WaitFor("text:今天的会话", 5*time.Second)
	if len(app.Query("text:很久以前的会话")) != 0 {
		t.Fatal("the ten-day-old session shows before the row is opened")
	}
	app.WaitFor("id:mobile-sessions-more", 5*time.Second)
	// A press can land while the list is still settling; try again.
	for i := 0; i < 4; i++ {
		app.Press("id:mobile-sessions-more")
		if waitQuiet(app, "id:mobile-sessions-fewer", 2*time.Second) {
			break
		}
	}
	waitApp(app, "text:很久以前的会话", 5*time.Second)
	app.WaitFor("id:mobile-sessions-fewer", 5*time.Second)
	for i := 0; i < 4; i++ {
		app.Press("id:mobile-sessions-fewer")
		if waitQuiet(app, "id:mobile-sessions-more", 2*time.Second) {
			break
		}
	}
	app.WaitForGone("text:很久以前的会话", 5*time.Second)
}
