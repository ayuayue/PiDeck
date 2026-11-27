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
	t.Cleanup(closeAllPi)
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

	// Both row actions stay on the row, so the plus never moves when the
	// pointer arrives and the menu needs no hover to reach.
	if got, want := len(screen.Query("id:project-new-session")), 2; got != want {
		t.Fatalf("rows show %d new-session actions, want %d", got, want)
	}
	if got, want := len(screen.Query("id:project-more-menu")), 2; got != want {
		t.Fatalf("rows show %d more actions, want %d", got, want)
	}
	plus := screen.Find("id:project-new-session >> nth=0").Bounds()
	screen.Hover("id:project-row >> nth=0")
	screen.Settle()
	if got := screen.Find("id:project-new-session >> nth=0").Bounds(); got != plus {
		t.Fatalf("the new-session action moved from %v to %v when the pointer arrived", plus, got)
	}
	screen.Press("id:project-more-menu >> nth=0")
	screen.WaitFor("text:在此新建会话", 5*time.Second)
	// The pointer goes to the popup, not to stay on the row: the menu stays
	// open for it.
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

// TestProjectListSeparatesProjects checks that one project's open sessions
// are told from the next project by a hairline, not by counting folder rows.
func TestProjectListSeparatesProjects(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	_, screen := railFixture(t, first, second)
	waitProjects(t, screen, 2)
	if got, want := len(screen.Query("id:project-divider")), 1; got != want {
		t.Fatalf("two projects show %d dividers, want %d", got, want)
	}
	firstRow := screen.Find("id:project-row >> nth=0").Bounds()
	secondRow := screen.Find("id:project-row >> nth=1").Bounds()
	divider := screen.Find("id:project-divider").Bounds()
	if divider.Origin.Y < firstRow.Origin.Y+firstRow.Size.Height || divider.Origin.Y >= secondRow.Origin.Y {
		t.Fatalf("the divider sits at y=%v, outside the gap between rows at y=%v and y=%v",
			divider.Origin.Y, firstRow.Origin.Y, secondRow.Origin.Y)
	}
}

// TestSingleProjectHasNoDivider checks that a lone project gets no line:
// there is no second project for it to divide from.
func TestSingleProjectHasNoDivider(t *testing.T) {
	_, screen := railFixture(t, t.TempDir())
	waitProjects(t, screen, 1)
	if got := len(screen.Query("id:project-divider")); got != 0 {
		t.Fatalf("a single project shows %d dividers, want 0", got)
	}
}

// TestRailColumnHeaderMenus checks the block above each column's rows:
// the project list's own actions and the chat list's.
func TestRailColumnHeaderMenus(t *testing.T) {
	project := t.TempDir()
	built, screen := railFixture(t, project)
	waitProjects(t, screen, 1)

	// 全部收起 folds every project from the column's own menu.
	screen.Press("id:project-header-menu")
	screen.WaitFor("text:刷新所有项目", 5*time.Second)
	screen.Press("text:全部收起")
	screen.WaitForGone("text:刷新所有项目", 5*time.Second)
	screen.WaitUntil(5*time.Second, func() bool {
		expanded := true
		screen.Post(func() {
			if list := built.projects(); len(list) == 1 {
				expanded = list[0].Expanded.GetUntracked()
			}
		})
		screen.Settle()
		return !expanded
	})

	// 刷新所有项目 reads the projects again and leaves the rows alone.
	screen.Press("id:project-header-menu")
	screen.WaitFor("text:刷新所有项目", 5*time.Second)
	screen.Press("text:刷新所有项目")
	screen.WaitForGone("text:刷新所有项目", 5*time.Second)
	waitProjects(t, screen, 1)

	// 移除所有项目 asks first, then leaves the folder on disk.
	screen.Press("id:project-header-menu")
	screen.WaitFor("text:移除所有项目…", 5*time.Second)
	screen.Press("text:移除所有项目…")
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	screen.Press("id:confirm-ok")
	screen.WaitUntil(5*time.Second, func() bool {
		screen.Settle()
		return len(screen.Query("id:project-row")) == 0
	})
	if _, err := os.Stat(project); err != nil {
		t.Fatalf("removing the project touched its folder: %v", err)
	}
	// The dialog goes before the next column is pressed: its backdrop would
	// take the press as its own.
	screen.WaitForGone("id:confirm", 5*time.Second)

	// The chat column starts the same way, with the chats' own actions.
	screen.Press("id:rail-tab-chat")
	screen.WaitFor("id:rail-new-chat", 5*time.Second)
	if got := screen.Find("id:chat-total").Text; got != "0" {
		t.Fatalf("the chat count says %q, want 0", got)
	}
	screen.Press("id:chat-header-menu")
	screen.WaitFor("text:刷新对话", 5*time.Second)
	screen.WaitFor("text:在文件管理器中打开", 5*time.Second)
	screen.Key("escape")
	screen.WaitForGone("text:刷新对话", 5*time.Second)
}

// TestSessionRowKeepsItsMenu checks that a session's own actions sit on its
// row, so managing one never means guessing that a right-click opens them.
func TestSessionRowKeepsItsMenu(t *testing.T) {
	project := t.TempDir()
	built, screen := railFixture(t, project)
	// An empty PATH keeps pi from starting: the row and its menu are what
	// this checks, not the agent.
	t.Setenv("PATH", t.TempDir())
	waitProjects(t, screen, 1)
	screen.Post(func() {
		ws := built.workspaceOf(project)
		s := built.blankSession(newSessionID(), ws, "菜单里的会话")
		ws.Sessions.Update(func(list []*session) []*session { return append([]*session{s}, list...) })
	})
	screen.WaitFor("id:session-row", 5*time.Second)
	if got, want := len(screen.Query("id:session-more-menu")), 1; got != want {
		t.Fatalf("a session row shows %d menus, want %d", got, want)
	}
	screen.Press("id:session-more-menu")
	// The menu is the row's action, not a second press on the row: it does
	// not open the session the row stands for.
	if got := built.activeID.GetUntracked(); got != "" {
		t.Fatalf("pressing the row's menu opened session %q", got)
	}
	screen.WaitFor("text:重命名", 5*time.Second)
	screen.Press("text:重命名")
	screen.WaitFor("id:rename", 5*time.Second)
	screen.Press("id:rename-cancel")
	screen.WaitForGone("id:rename", 5*time.Second)
}
