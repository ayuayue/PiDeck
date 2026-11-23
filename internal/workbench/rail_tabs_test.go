//go:build !js && !android && !ios

package workbench

// Checks the rail's three columns, the project column's actions, and that a
// new session starts empty instead of waiting behind a history skeleton.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// railFixture starts the app on a config with the given project folders.
func railFixture(t *testing.T, projects ...string) (*app, *nsgotest.App) {
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
	}, nsgotest.Size(1200, 800))
	if built == nil {
		t.Fatal("the app was not built")
	}
	// Session drafts write in the background: join them before the temp
	// home is removed, as the other fixtures do.
	t.Cleanup(sessionDraftWrites.Wait)
	t.Cleanup(built.closeDiag)
	return built, screen
}

// waitProjects waits for the projects column to list n rows.
func waitProjects(t *testing.T, screen *nsgotest.App, n int) {
	t.Helper()
	screen.WaitUntil(10*time.Second, func() bool {
		screen.Settle()
		return len(screen.Query("id:project-row")) == n
	})
}

func TestNewSessionStartsEmptyWithoutHistorySkeleton(t *testing.T) {
	project := t.TempDir()
	built, screen := railFixture(t, project)
	screen.Post(func() {
		ws := built.workspaceOf(project)
		s := built.blankSession(newSessionID(), ws, "新会话")
		ws.Sessions.Update(func(list []*session) []*session { return append([]*session{s}, list...) })
		built.activeID.Set(s.ID)
		built.tabs.Set([]string{s.ID})
	})
	screen.WaitFor("id:chat-start", 5*time.Second)
	if got := len(screen.Query("id:history-skeleton")); got != 0 {
		t.Fatalf("a new session shows %d history skeletons; it has nothing to read", got)
	}
	if got := len(screen.Query("id:composer")); got != 1 {
		t.Fatalf("a new session shows %d composers, want 1", got)
	}
}

func TestRailColumnsAndProjectActions(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	built, screen := railFixture(t, first, second)
	waitProjects(t, screen, 2)
	if got := screen.Find("id:project-total").Text; got != "2" {
		t.Fatalf("the project count says %q, want 2", got)
	}

	// The count's plus adds a project, on this machine or elsewhere.
	screen.Press("id:add-project")
	screen.WaitFor("id:add-project-local", 5*time.Second)
	screen.WaitFor("id:add-project-ssh", 5*time.Second)
	screen.WaitFor("id:add-project-wsl", 5*time.Second)
	screen.Key("escape")
	screen.WaitForGone("id:add-project-local", 5*time.Second)

	// A row keeps its new-session action out and shows the rest on hover.
	if got, want := len(screen.Query("id:project-new-session")), 2; got != want {
		t.Fatalf("rows show %d new-session actions, want %d", got, want)
	}
	if got := len(screen.Query("id:project-more-menu")); got != 0 {
		t.Fatalf("a row shows %d more actions before the pointer is on it", got)
	}
	screen.Hover("id:project-row >> nth=0")
	screen.WaitFor("id:project-more-menu", 5*time.Second)
	screen.Press("id:project-more-menu")
	screen.WaitFor("text:在此新建会话", 5*time.Second)
	// The pointer goes to the popup, not to stay on the row: the menu and
	// its trigger stay out for it.
	screen.HoverOut()
	screen.WaitFor("text:在此新建会话", 5*time.Second)
	screen.Key("escape")
	screen.WaitForGone("text:在此新建会话", 5*time.Second)

	// Clicking a project selects it, so the next session runs there.
	screen.Press("id:project-row >> nth=0")
	screen.WaitUntil(5*time.Second, func() bool {
		active := ""
		screen.Post(func() { active = built.activeWS.GetUntracked() })
		screen.Settle()
		return active != ""
	})
	screen.Post(func() {
		ws := built.workspaceByWireKey(built.activeWS.GetUntracked())
		if ws == nil || ws.Chat {
			t.Errorf("clicking a project selected %q, not a project", built.activeWS.GetUntracked())
		}
	})

	// The chat column owns the built-in chat, the projects column its projects.
	screen.Press("id:rail-tab-chat")
	screen.WaitFor("id:rail-new-chat", 5*time.Second)
	if got := len(screen.Query("id:project-row")); got != 0 {
		t.Fatalf("the chat column lists %d projects", got)
	}
	screen.Press("id:rail-tab-activity")
	screen.WaitFor("text:目前没有需要处理的对话", 5*time.Second)
	screen.Press("id:rail-tab-projects")
	waitProjects(t, screen, 2)
}

func TestProjectRowNewSessionUsesThatProject(t *testing.T) {
	// An empty PATH keeps pi from starting: the session and its project are
	// what this checks, not the agent.
	first, second := t.TempDir(), t.TempDir()
	built, screen := railFixture(t, first, second)
	t.Setenv("PATH", t.TempDir())
	waitProjects(t, screen, 2)
	screen.Press("id:project-new-session >> nth=1")
	var started *workspace
	screen.WaitUntil(5*time.Second, func() bool {
		started = nil
		screen.Post(func() {
			for _, path := range []string{first, second} {
				if ws := built.workspaceOf(path); ws != nil && len(ws.Sessions.GetUntracked()) > 0 {
					started = ws
				}
			}
		})
		screen.Settle()
		return started != nil
	})
	screen.Post(func() {
		if started == nil {
			t.Fatal("the row's action started no session in its project")
		}
		if !samePath(built.activeWS.GetUntracked(), started.Path) {
			t.Fatalf("the new session runs in %q, want %q", built.activeWS.GetUntracked(), started.Path)
		}
	})
}

func TestRailHeaderOrderAndMore(t *testing.T) {
	built, screen := railFixture(t, t.TempDir())
	waitProjects(t, screen, 1)

	// PiDeck's order: new session, search, 更多, then the columns.
	order := []string{"rail-new-session", "rail-search", "rail-more", "rail-tab-activity", "rail-tab-chat", "rail-tab-projects"}
	last := core.Points(-1)
	for _, id := range order {
		y := screen.Find("id:" + id).Bounds().Origin.Y
		if y < last {
			t.Fatalf("%s sits at y=%v, above the row before it (y=%v)", id, y, last)
		}
		last = y
	}

	// 更多 holds the manager pages, folded away until it is asked.
	if got := len(screen.Query("id:rail-agents")); got != 0 {
		t.Fatalf("更多 shows %d entries before it is opened", got)
	}
	screen.Press("id:rail-more")
	screen.WaitFor("id:rail-agents", 5*time.Second)
	screen.WaitFor("id:rail-tasks", 5*time.Second)
	screen.WaitFor("id:rail-favorites", 5*time.Second)
	screen.Press("id:rail-more")
	screen.WaitForGone("id:rail-agents", 5*time.Second)

	// The columns switch with the pointer, one at a time.
	screen.Press("id:rail-tab-activity")
	screen.WaitFor("text:目前没有需要处理的对话", 5*time.Second)
	screen.Press("id:rail-tab-projects")
	waitProjects(t, screen, 1)
	if ws := built.workspaceOf(built.activeWS.GetUntracked()); ws != nil {
		t.Fatalf("no session was opened, yet %q is the active project", built.activeWS.GetUntracked())
	}
}
