//go:build !js && !android && !ios

package workbench

// Checks the tab bar against a full bar: the focused tab (a session's or a
// pane's) is scrolled into sight, and every tab's dot says what its
// session is doing.

import (
	"fmt"
	"testing"
	"time"

	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

// tabTabs returns the tab bar's tabs, left to right.
func tabTabs(t *testing.T, screen *nsgotest.App) []*nsgotest.View {
	t.Helper()
	return screen.Query("id:tab")
}

// inTabBar reports whether a tab shows inside the bar's viewport.
func inTabBar(screen *nsgotest.App, selector string) bool {
	bar := screen.Find("id:tab-bar").Bounds()
	tab := screen.Find(selector).Bounds()
	return tab.Size.Width > 0 && tab.Origin.X >= bar.Origin.X && tab.Origin.X+tab.Size.Width <= bar.Origin.X+bar.Size.Width
}

func TestTabBarRevealsTheFocusedTab(t *testing.T) {
	project := t.TempDir()
	built, screen := railFixture(t, project)
	screen.WaitFor("id:project-row", 5*time.Second)
	const tabs = 12
	screen.Post(func() {
		ws := built.workspaceOf(project)
		for i := 0; i < tabs; i++ {
			id := fmt.Sprintf("tab-%02d", i)
			s := built.blankSession(id, ws, fmt.Sprintf("会话 %02d", i))
			ws.Sessions.Update(func(list []*session) []*session { return append(list, s) })
			built.addTab(id)
		}
	})
	screen.WaitUntil(5*time.Second, func() bool {
		screen.Settle()
		return len(tabTabs(t, screen)) == tabs
	})

	// The last tab opens: a full bar brings it into sight.
	screen.Post(func() { built.selectSession(built.byID[fmt.Sprintf("tab-%02d", tabs-1)]) })
	screen.WaitUntil(5*time.Second, func() bool {
		screen.Settle()
		return inTabBar(screen, "id:tab >> nth="+fmt.Sprint(tabs-1))
	})

	// A pane's tab sits after the sessions': opening one shows it too.
	screen.Post(func() { built.openPane(paneSettings) })
	screen.WaitFor("id:pane-tab-settings", 5*time.Second)
	screen.WaitUntil(5*time.Second, func() bool { screen.Settle(); return inTabBar(screen, "id:pane-tab-settings") })
}

func TestTabDotsSayWhatTheSessionIsDoing(t *testing.T) {
	project := t.TempDir()
	built, screen := railFixture(t, project)
	screen.WaitFor("id:project-row", 5*time.Second)
	type state struct {
		id     string
		title  string
		settle func(*session)
	}
	states := []state{
		{"dot-fresh", "没开过的会话", func(*session) {}},
		{"dot-idle", "启动后空闲", func(s *session) { s.readySig.Set(true) }},
		{"dot-running", "正在运行", func(s *session) { s.readySig.Set(true); s.status.Set(statusRunning) }},
		{"dot-failed", "启动失败", func(s *session) { s.status.Set(statusFailed) }},
	}
	screen.Post(func() {
		ws := built.workspaceOf(project)
		for _, st := range states {
			s := built.blankSession(st.id, ws, st.title)
			st.settle(s)
			ws.Sessions.Update(func(list []*session) []*session { return append(list, s) })
			built.addTab(st.id)
		}
	})
	screen.WaitUntil(5*time.Second, func() bool {
		screen.Settle()
		return len(tabTabs(t, screen)) == len(states)
	})

	// Grey before it starts, blue while up and idle, amber while working,
	// red when it failed: the rail's row says the same.
	want := map[string]core.Color{
		"dot-fresh":   ui.ColorsOf(built.cx).Faint(),
		"dot-idle":    viewkit.Idle,
		"dot-running": viewkit.Working,
		"dot-failed":  built.cx.Palette().Danger,
	}
	for _, st := range states {
		if got := screen.Find("id:tab-status-" + st.id).Style.Background; got != want[st.id] {
			t.Errorf("tab %s dot = %v, want %v", st.title, got, want[st.id])
		}
		if got := screen.Find("id:session-status-" + st.id).Style.Background; got != want[st.id] {
			t.Errorf("row %s dot = %v, want %v", st.title, got, want[st.id])
		}
	}
}
