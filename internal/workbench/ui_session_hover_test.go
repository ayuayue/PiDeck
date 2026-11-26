//go:build !js && !android && !ios

package workbench

// Checks the card a resting pointer opens on a rail row and a tab: what it
// says, that it waits for a rest, that one replaces another instead of both
// showing, and that keyboard focus does not open it.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// hoverFixture starts the rail as a desktop app: a hover card is a fine
// pointer's, and a phone's environment opens it by press instead.
func hoverFixture(t *testing.T, projects ...string) (*app, *nsgotest.App) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	cfg := config{Version: configVersion, Theme: "light", ScanPi: false, AutoModelCatalog: false, SidebarOpen: true}
	for _, project := range projects {
		cfg.Workspaces = append(cfg.Workspaces, workspaceCfg{Path: project, Expanded: true})
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	if built == nil {
		t.Fatal("the app was not built")
	}
	t.Cleanup(sessionDraftWrites.Wait)
	t.Cleanup(built.closeDiag)
	return built, screen
}

// hoverSession adds one session to the project's list, as a scan would.
func hoverSession(screen *nsgotest.App, built *app, project string, meta sessionMeta) {
	screen.Post(func() {
		ws := built.workspaceOf(project)
		if ws == nil {
			return
		}
		s := built.makeSession(meta, ws.Target)
		ws.Sessions.Update(func(list []*session) []*session {
			return append([]*session{s}, list...)
		})
	})
}

func TestRailHoverCardShowsFullTitleCreatedAndFolder(t *testing.T) {
	project := t.TempDir()
	built, screen := hoverFixture(t, project)
	long := "把会话列表的悬停预览做成一张小卡片，标题要完整，不要像行里那样只有一行"
	created := time.Date(2026, 11, 20, 9, 30, 0, 0, time.Local)
	hoverSession(screen, built, project, sessionMeta{ID: "hover-rail", Cwd: project, Title: long,
		Created: created, Updated: created.Add(2 * time.Hour)})
	screen.WaitFor("id:session-row", 10*time.Second)

	screen.Hover("id:session-row >> nth=0")
	screen.Advance(400 * time.Millisecond)
	screen.WaitFor("id:session-hover-title", 5*time.Second)

	if got := screen.Find("id:session-hover-title").Text; got != long {
		t.Fatalf("the card title reads %q, want the whole title %q", got, long)
	}
	if got, want := screen.Find("id:session-hover-created").Text, created.Format("2006-01-02 15:04"); got != want {
		t.Fatalf("the card's created time reads %q, want %q", got, want)
	}
	if got := screen.Find("id:session-hover-dir").Text; !strings.HasSuffix(got, filepath.Base(project)) {
		t.Fatalf("the card's folder reads %q, want it to end in %q", got, filepath.Base(project))
	}
	if b := screen.Find("id:session-hover-card-rail").Bounds(); b.Size.Width > 250 {
		t.Fatalf("the rail card is %v wide, want the same small card the tab shows", b.Size.Width)
	}

	// The card stays while the pointer moves onto it, so its text can be
	// selected or read without the card vanishing under the pointer.
	screen.Hover("id:session-hover-card-rail")
	screen.Advance(300 * time.Millisecond)
	if !screen.Exists("id:session-hover-card-rail") {
		t.Fatal("the card closed as the pointer moved onto it")
	}

	// A press picks the session; the preview has done its job and goes.
	screen.Press("id:session-row")
	screen.Advance(300 * time.Millisecond)
	if screen.Exists("id:session-hover-title") {
		t.Fatal("the card stayed after the row was pressed")
	}

	screen.HoverOut()
	screen.Advance(300 * time.Millisecond)
	if screen.Exists("id:session-hover-title") {
		t.Fatal("the card stayed after the pointer left the row")
	}
}

func TestRailHoverCardWaitsForARestAndReplacesTheLast(t *testing.T) {
	project := t.TempDir()
	built, screen := hoverFixture(t, project)
	first := time.Date(2026, 11, 20, 8, 0, 0, 0, time.Local)
	hoverSession(screen, built, project, sessionMeta{ID: "hover-a", Cwd: project, Title: "第一个会话",
		Created: first, Updated: first.Add(time.Hour)})
	hoverSession(screen, built, project, sessionMeta{ID: "hover-b", Cwd: project, Title: "第二个会话",
		Created: first, Updated: first.Add(2 * time.Hour)})
	screen.WaitUntil(10*time.Second, func() bool {
		screen.Settle()
		return len(screen.Query("id:session-row")) == 2
	})

	// A pass over both rows, faster than the rest the card waits for.
	screen.Hover("id:session-row >> nth=0")
	screen.Advance(120 * time.Millisecond)
	screen.Hover("id:session-row >> nth=1")
	screen.Advance(120 * time.Millisecond)
	screen.HoverOut()
	screen.Advance(time.Second)
	if screen.Exists("id:session-hover-title") {
		t.Fatal("a card opened for a row the pointer only passed over")
	}

	// Resting on the newest row opens its own card alone.
	screen.Hover("id:session-row >> nth=0")
	screen.Advance(400 * time.Millisecond)
	screen.WaitFor("id:session-hover-title", 5*time.Second)
	if got := screen.Find("id:session-hover-title").Text; got != "第二个会话" {
		t.Fatalf("the card reads %q, want the session under the pointer", got)
	}

	// Moving to the other row closes the first card before the second opens:
	// one at a time, never two catching up with the pointer.
	screen.Hover("id:session-row >> nth=1")
	screen.Advance(400 * time.Millisecond)
	screen.WaitFor("id:session-hover-title", 5*time.Second)
	if got := len(screen.Query("id:session-hover-title")); got != 1 {
		t.Fatalf("%d cards show at once, want 1", got)
	}
	if got := screen.Find("id:session-hover-title").Text; got != "第一个会话" {
		t.Fatalf("the card reads %q, want the new row's session", got)
	}
}

func TestTabHoverCardIsSmallAndDoesNotOpenOnFocus(t *testing.T) {
	project := t.TempDir()
	built, screen := hoverFixture(t, project)
	screen.Post(func() {
		ws := built.workspaceOf(project)
		s := built.blankSession("hover-tab", ws, "标签页上的完整标题")
		ws.Sessions.Update(func(list []*session) []*session { return append([]*session{s}, list...) })
		built.activeID.Set(s.ID)
		built.tabs.Set([]string{s.ID})
	})
	screen.WaitFor("id:tab", 10*time.Second)

	screen.Hover("id:tab")
	screen.Advance(400 * time.Millisecond)
	screen.WaitFor("id:session-hover-card-tab", 5*time.Second)
	if got, want := screen.Find("id:session-hover-title").Text, "标签页上的完整标题"; got != want {
		t.Fatalf("the tab card reads %q, want %q", got, want)
	}
	// A glance, not a page: the tab's card is the same small card the rail
	// shows, and stays near that width.
	if b := screen.Find("id:session-hover-card-tab").Bounds(); b.Size.Width > 250 {
		t.Fatalf("the tab card is %v wide, want a small card", b.Size.Width)
	}

	screen.HoverOut()
	screen.Advance(300 * time.Millisecond)
	if screen.Exists("id:session-hover-card-tab") {
		t.Fatal("the tab card stayed after the pointer left")
	}

	// Focus alone is not a pointer resting: clicking or tabbing to a tab
	// must not raise a card the user did not ask for.
	screen.Focus("id:tab")
	screen.Advance(time.Second)
	if screen.Exists("id:session-hover-card-tab") {
		t.Fatal("keyboard focus opened the tab's card")
	}

	// The focus stays on the tab, yet a pointer that rested and left takes
	// the card with it: focus must not keep a card on screen.
	screen.Hover("id:tab")
	screen.Advance(400 * time.Millisecond)
	screen.WaitFor("id:session-hover-card-tab", 5*time.Second)
	screen.HoverOut()
	screen.Advance(300 * time.Millisecond)
	if screen.Exists("id:session-hover-card-tab") {
		t.Fatal("the card stayed after the pointer left the focused tab")
	}
}
