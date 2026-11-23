//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestNativeHomeScreen(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	_, screen := startNativeSettingsApp(t)
	screen.WaitFor("id:welcome-primary", 10*time.Second)
	shot(screen, "comparison/home")
}

func TestNativeChatDrawerScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	_, screen, _ := startNativeSurfaceApp(t)
	screen.WaitFor("id:chat-transcript", 5*time.Second)
	screen.WaitFor("text:入口已经连通。", 5*time.Second)
	shot(screen, "comparison/session-complete")

	screen.Press("id:drawer-toggle")
	screen.WaitFor("id:drawer-tab-overview", 5*time.Second)
	shot(screen, "comparison/drawer-overview")
	screen.Focus("id:drawer-tab-overview")
	screen.Key("right")
	screen.WaitFor("text:readme.md", 5*time.Second)
	shot(screen, "comparison/drawer-files")
	screen.Key("end")
	screen.WaitFor("text:初始化 Git 仓库", 5*time.Second)
	shot(screen, "comparison/drawer-git")
	screen.Press("id:drawer-close")
	screen.Advance(250 * time.Millisecond)
	screen.WaitForGone("id:drawer-tabs", 5*time.Second)
}

func TestNativeSessionRenameDialogScreen(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	built, screen, sess := startNativeSurfaceApp(t)
	onNativeUI(t, screen, built, func() { built.askRename(sess) })
	screen.WaitFor("id:rename", 5*time.Second)
	shot(screen, "comparison/session-rename")
	screen.Press("id:rename-cancel")
	screen.Advance(250 * time.Millisecond)
	screen.WaitForGone("id:rename", 5*time.Second)
	onNativeUI(t, screen, built, func() { built.askRename(sess) })
	screen.WaitFor("id:rename", 5*time.Second)
	screen.Key("escape")
	if runtime.GOOS == "windows" {
		// NSGo on Windows first releases the focused text field.
		screen.Key("escape")
	}
	screen.Advance(250 * time.Millisecond)
	screen.WaitForGone("id:rename", 5*time.Second)
}

func TestSessionMenuSurvivesEmptyPiRescan(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	screen.RightClick("id:session-row")
	screen.WaitFor("role:menuitem 归档", 5*time.Second)
	// An environment probe can finish while this menu is open. Disabling
	// external history must not publish another empty list and remount it.
	onNativeUI(t, screen, built, built.rescanPi)
	if len(screen.Query("role:menuitem 归档")) != 1 {
		t.Fatal("an empty Pi rescan dismissed the session menu")
	}
	screen.Press("role:menuitem 归档")
	screen.WaitForGone("id:session-row", 5*time.Second)
	onNativeUI(t, screen, built, func() {
		if !built.sessionArchived(sess.ID) {
			t.Error("the session menu did not archive the selected session")
		}
	})
}

func TestSessionTabMenuTargetsClickedSession(t *testing.T) {
	built, screen, active := startNativeSurfaceApp(t)
	const otherTitle = "另一个会话"
	var other *session
	onNativeUI(t, screen, built, func() {
		ws := built.workspaceOf(active.WS)
		other = built.blankSession("fixture-other", ws, otherTitle)
		built.byID[other.ID] = other
		built.all = append(built.all, other)
		ws.Sessions.Update(func(list []*session) []*session { return append(list, other) })
		built.tabs.Set([]string{active.ID, other.ID})
	})
	tab := "id:tab >> nth=1"
	screen.RightClick(tab)
	screen.Press("role:menuitem 重命名")
	screen.WaitFor("id:rename", 5*time.Second)
	screen.Clear("label:会话名称")
	screen.Type("label:会话名称", "后台标签的新名称")
	screen.Press("id:rename-ok")
	screen.Advance(250 * time.Millisecond)
	screen.WaitForGone("id:rename", 5*time.Second)
	onNativeUI(t, screen, built, func() {
		if got := other.title.GetUntracked(); got != "后台标签的新名称" {
			t.Errorf("renamed title = %q, want the new name", got)
		}
		if got := built.activeID.GetUntracked(); got != active.ID || active.title.GetUntracked() != "检查会话界面" {
			t.Errorf("renaming a background tab changed the current session: %q", got)
		}
	})
	screen.RightClick(tab)
	screen.Press("role:menuitem 导出…")
	screen.WaitFor("id:export-dialog", 5*time.Second)
	onNativeUI(t, screen, built, func() {
		if got := built.exportID; got != other.ID {
			t.Errorf("export target = %q, want %q", got, other.ID)
		}
	})
	shot(screen, "comparison/session-export")
	screen.Press("id:export-cancel")
	screen.Advance(250 * time.Millisecond)
	screen.WaitForGone("id:export-dialog", 5*time.Second)
}

func TestComposerControlsFitWithDrawerOpen(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	onNativeUI(t, screen, built, func() {
		sess.model.Set(modelInfo{Provider: "fixture-provider", ID: "fixture-model", Name: strings.Repeat("Long model name ", 5)})
		sess.levels.Set([]string{"off", "low", "medium", "high"})
	})
	screen.Resize(1000, 720)
	screen.Press("id:drawer-toggle")
	screen.WaitFor("id:drawer-tab-overview", 5*time.Second)
	screen.Advance(250 * time.Millisecond)
	card := screen.Find("id:composer-card").Bounds()
	column := screen.Find("id:transcript-column").Bounds()
	viewport := screen.Find("id:transcript").Bounds()
	if card.Size.Width < min(chatColumnMin, viewport.Size.Width-2*chatSidePadding)-1 || card.Size.Width != column.Size.Width {
		t.Fatalf("composer width = %v, transcript width = %v, available width = %v", card.Size.Width, column.Size.Width, viewport.Size.Width)
	}
	add := screen.Find("id:composer-add").Bounds()
	model := screen.Find("id:composer-model-controls").Bounds()
	picker := screen.Find("id:model-picker").Bounds()
	name := screen.Find("id:model-picker-name").Bounds()
	effort := screen.Find("id:effort-picker").Bounds()
	tools := screen.Find("id:composer-tools").Bounds()
	if model.Origin.X < card.Origin.X || model.Origin.X+model.Size.Width > card.Origin.X+card.Size.Width+1 {
		t.Fatalf("model controls %v extend beyond composer %v", model, card)
	}
	for _, other := range []core.Bounds{add, tools} {
		if model.Origin.X < other.Origin.X+other.Size.Width && other.Origin.X < model.Origin.X+model.Size.Width &&
			model.Origin.Y < other.Origin.Y+other.Size.Height && other.Origin.Y < model.Origin.Y+model.Size.Height {
			t.Fatalf("model controls %v overlap control %v", model, other)
		}
	}
	if picker.Origin.X < model.Origin.X || picker.Origin.X+picker.Size.Width > effort.Origin.X+1 ||
		effort.Origin.X+effort.Size.Width > model.Origin.X+model.Size.Width+1 {
		t.Fatalf("model picker %v and effort %v do not fit side by side in %v", picker, effort, model)
	}
	if name.Size.Width < 24 || name.Origin.X+name.Size.Width > picker.Origin.X+picker.Size.Width+1 {
		t.Fatalf("model name %v is not readable within picker %v", name, picker)
	}
	screen.Press("id:model-picker")
	screen.WaitFor("id:model-search", 5*time.Second)
	screen.Press("id:model-picker")
	screen.Advance(250 * time.Millisecond)
	screen.Press("id:effort-picker")
	screen.WaitFor("text:默认", 5*time.Second)
	screen.Press("id:effort-picker")
	shot(screen, "comparison/composer-narrow")
	screen.Press("id:composer-tools")
	screen.WaitFor("id:prompt-enhance", 5*time.Second)
}

func TestNativeComposerAndContextMenus(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	_, screen, _ := startNativeSurfaceApp(t)
	screen.RightClick("text:入口已经连通。")
	screen.WaitFor("role:menuitem 收藏这条回复", 5*time.Second)
	shot(screen, "comparison/reply-menu")
	screen.Key("escape")

	screen.Press("id:composer-add")
	screen.WaitFor("text:计划模式", 5*time.Second)
	shot(screen, "comparison/composer-add-menu")
	screen.Key("escape")
	screen.Press("id:drawer-toggle")
	screen.Press("id:drawer-tab-files")
	screen.WaitFor("text:readme.md", 5*time.Second)
	screen.RightClick("text:readme.md")
	screen.WaitFor("text:在编辑器中打开", 5*time.Second)
	screen.WaitFor("text:用外部编辑器打开", 5*time.Second)
	shot(screen, "comparison/file-menu")
	screen.Key("escape")
	screen.Press("id:drawer-toggle")
	screen.RightClick("id:tab")
	screen.WaitFor("text:关闭右侧标签", 5*time.Second)
	screen.WaitFor("text:重命名", 5*time.Second)
	shot(screen, "comparison/session-tab-menu")
	screen.Key("escape")
	screen.RightClick("id:project-row")
	screen.WaitFor("text:在此新建会话", 5*time.Second)
	shot(screen, "comparison/project-menu")
	screen.Scroll("role:menu", 300)
	screen.WaitFor("text:移除项目", 5*time.Second)
	shot(screen, "comparison/project-menu-scrolled")
}

func TestNativeWorkspaceTabScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen, sess := startNativeSurfaceApp(t)
	screen.RightClick("id:chat-reply")
	screen.Press("role:menuitem 收藏这条回复")
	screen.WaitFor("text:已收藏回复", 5*time.Second)
	favorites := built.favoriteList()
	if len(favorites) != 1 || favorites[0].SessionID != sess.ID || !strings.Contains(favorites[0].Text, "入口已经连通。") {
		t.Fatalf("the reply menu saved the wrong answer: %+v", favorites)
	}
	screen.Press("id:rail-more")
	screen.Press("id:rail-favorites")
	screen.WaitFor("id:"+favoriteKeyDown(favorites[0]), 5*time.Second)
	shot(screen, "comparison/favorites")
	screen.Press("id:favorite-filter-session")
	screen.WaitFor("text:没有匹配的收藏。", 5*time.Second)
	screen.Press("id:favorite-filter-reply")
	screen.WaitFor("id:"+favoriteKeyDown(favorites[0]), 5*time.Second)

	screen.Press("id:rail-agents")
	screen.WaitFor("id:agent-field-prompt", 5*time.Second)
	shot(screen, "comparison/agents")
	screen.Press("id:rail-tasks")
	screen.WaitFor("id:task-new", 5*time.Second)
	shot(screen, "comparison/tasks")
	screen.Press("id:task-new")
	screen.WaitFor("id:task-form", 5*time.Second)
	shot(screen, "comparison/task-form")
	screen.Press("id:task-save")
	screen.WaitFor("text:名称和提示词都要填。", 5*time.Second)
	screen.Press("role:button 取消")
	screen.Advance(250 * time.Millisecond)
	screen.WaitForGone("id:task-form", 5*time.Second)
	screen.Press("id:pane-tab-favorites")
	screen.Press("id:favorite-open-" + favorites[0].ID)
	screen.WaitFor("id:chat-reply", 5*time.Second)
	for _, id := range []string{"favorites", "agents", "tasks"} {
		screen.Find("id:pane-tab-" + id)
	}
}

func startNativeSurfaceApp(t *testing.T) (*app, *nsgotest.App, *session) {
	t.Helper()
	home, project := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	if err := os.WriteFile(filepath.Join(project, "readme.md"), []byte("# Local fixture\n\nA file for the drawer view."), 0o600); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: project, Name: "Fixture", Expanded: true}},
		Theme: "light", SidebarOpen: true, ScanPi: false, AutoModelCatalog: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var built *app
	var sess *session
	// Dispose the window before waiting for the final draft write.
	t.Cleanup(sessionDraftWrites.Wait)
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		ws := &workspace{Path: project, Name: "Fixture", Target: localTarget,
			Expanded: core.NewSignal(cx, true), Sessions: core.NewSignalFunc(cx, []*session(nil), nil),
			Pi: core.NewSignalFunc(cx, []*session(nil), nil), PiOpen: core.NewSignal(cx, false),
			PiLoading: core.NewSignal(cx, false), Visible: core.NewSignal(cx, 0)}
		built.workspaces.Set([]*workspace{ws})
		sess = built.blankSession("fixture-chat", ws, "检查会话界面")
		now := time.Now()
		sess.turns.Set([]turn{{ID: "fixture-answer", Prompt: "检查这段代码路径", Final: "入口已经连通。\n\n下一步继续验证错误恢复与窄窗口布局。",
			Status: chat.Completed, Model: "fixture/model", Start: now.Add(-8 * time.Second), End: now}})
		sess.draft.Set("再检查一下空状态和错误提示。")
		ws.Sessions.Set([]*session{sess})
		built.byID[sess.ID] = sess
		built.all = append(built.all, sess)
		built.activeWS.Set(project)
		built.tabs.Set([]string{sess.ID})
		built.activeID.Set(sess.ID)
		return built.view()
	}, nsgotest.Size(1320, 860))
	t.Cleanup(built.closeDiag)
	screen.WaitFor("id:chat-transcript", 10*time.Second)
	return built, screen, sess
}
