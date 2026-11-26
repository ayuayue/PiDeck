//go:build !js && !android && !ios

package workbench

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestSessionManagerMenuScopes(t *testing.T) {
	built, screen, ws := sessionManagerFixture(t, 3)
	screen.Press("id:session-manager-close")
	screen.WaitForGone("id:session-manager", 5*time.Second)
	projectLabel := screen.Find("id:project-row >> nth=0").Props.Label
	screen.RightClick("id:project-row >> nth=0")
	screen.WaitFor("id:project-organize-menu", 5*time.Second)
	if len(screen.Query("text:复制项目路径")) != 0 {
		t.Fatal("secondary project actions leaked out of their submenu")
	}
	screen.Press("role:menuitem 会话管理…")
	screen.WaitFor("id:session-manager", 5*time.Second)
	screen.Post(func() {
		if got := built.sessionManager.workspace.GetUntracked().label(); got != projectLabel {
			t.Errorf("project menu manages %q, want clicked project %q", got, projectLabel)
		}
	})
	screen.Press("id:session-manager-close")
	screen.WaitForGone("id:session-manager", 5*time.Second)

	// A non-active column's context menu targets that column without
	// changing which column the user is viewing.
	screen.RightClick("id:rail-tab-chat")
	screen.WaitFor("role:menuitem 会话管理…", 5*time.Second)
	screen.Press("role:menuitem 会话管理…")
	screen.WaitFor("id:session-manager", 5*time.Second)
	screen.Post(func() {
		if !built.sessionManager.workspace.GetUntracked().Chat || built.railTab.GetUntracked() != railTabProjects {
			t.Error("chat context menu changed columns or targeted a project")
		}
	})
	screen.Press("id:session-manager-close")
	screen.WaitForGone("id:session-manager", 5*time.Second)

	var other *session
	screen.Post(func() {
		for _, candidate := range built.projects() {
			if candidate != ws {
				other = candidate.Sessions.GetUntracked()[0]
			}
		}
		built.tabs.Set([]string{"managed-00", other.ID})
		built.activeID.Set("managed-00")
	})
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:tab")) == 2 })
	screen.RightClick("id:tab >> nth=1")
	screen.WaitFor("id:session-agent-menu", 5*time.Second)
	screen.WaitFor("id:session-close-tabs-menu", 5*time.Second)
	if len(screen.Query("text:关闭右侧标签")) != 0 {
		t.Fatal("batch tab actions leaked out of their submenu")
	}
	screen.Press("role:menuitem 会话管理…")
	screen.WaitFor("id:session-manager", 5*time.Second)
	screen.Post(func() {
		if got := built.sessionManager.workspace.GetUntracked(); got.Path != other.WS || built.activeID.GetUntracked() != "managed-00" {
			t.Error("background tab menu did not preserve its project and the active tab")
		}
	})
	screen.Press("id:session-manager-close")
	screen.WaitForGone("id:session-manager", 5*time.Second)
	screen.RightClick("id:tab >> nth=1")
	screen.Press("id:session-location-menu")
	screen.WaitFor("role:menuitem 复制会话 ID", 5*time.Second)
	screen.Press("role:menuitem 复制会话 ID")
	if got := screen.Clipboard; got != other.ID {
		t.Fatalf("copied session ID = %q, want background tab %q", got, other.ID)
	}
	screen.RightClick("id:tab >> nth=1")
	screen.Press("id:session-organize-menu")
	screen.WaitFor("text:置顶会话", 5*time.Second)
	screen.Press("text:置顶会话")
	screen.Post(func() {
		if !built.isPinned(other.ID) || built.isPinned("managed-00") {
			t.Error("organize submenu pinned the wrong session")
		}
		built.activeWS.Set(projectWireKey(built.workspaceFor(other.Target, other.WS)))
	})
	screen.Press("id:project-header-menu")
	screen.Press("role:menuitem 会话管理…")
	screen.WaitFor("id:session-manager", 5*time.Second)
	screen.Post(func() {
		if got := built.sessionManager.workspace.GetUntracked(); got.Path != other.WS {
			t.Error("column manager ignored the selected project in favor of the active session")
		}
	})
	screen.Press("id:session-manager-close")
	screen.WaitForGone("id:session-manager", 5*time.Second)
	screen.RightClick("id:tab >> nth=0")
	screen.Press("id:session-close-tabs-menu")
	screen.WaitFor("text:关闭其他标签", 5*time.Second)
	screen.Press("text:关闭其他标签")
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:tab")) == 1 })
}

func TestNativeSessionManagerScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen, _ := sessionManagerFixture(t, 45)
	onNativeUI(t, screen, built, func() { built.theme.Set("light"); built.applyTheme() })
	screen.WaitFor("id:managed-select-managed-00", 5*time.Second)
	screen.Press("id:managed-select-managed-00")
	screen.Press("role:button 下一页")
	screen.WaitFor("id:managed-select-managed-20", 5*time.Second)
	screen.Press("id:managed-select-managed-20")
	shot(screen, "session-manager/light")
	onNativeUI(t, screen, built, func() { built.theme.Set("dark"); built.applyTheme() })
	shot(screen, "session-manager/dark")
	screen.Resize(900, 560)
	screen.WaitFor("id:session-manager-close", 5*time.Second)
	for _, id := range []string{"session-manager-project", "session-manager-query", "session-manager-agent", "session-manager-delete", "session-manager-close"} {
		bounds := screen.Find("id:" + id).Bounds()
		if bounds.Size.Width <= 0 || bounds.Origin.X < 0 || bounds.Origin.Y < 0 || bounds.Origin.X+bounds.Size.Width > 901 || bounds.Origin.Y+bounds.Size.Height > 561 {
			t.Fatalf("%s overflows the narrow window: %+v", id, bounds)
		}
	}
	shot(screen, "session-manager/narrow")
	screen.Press("id:session-manager-delete")
	screen.WaitFor("id:session-manager-delete-confirm", 5*time.Second)
	shot(screen, "session-manager/delete-confirm")
	screen.Press("id:session-manager-delete-cancel")
	screen.Press("id:session-manager-close")
	screen.WaitForGone("id:session-manager", 5*time.Second)
	screen.RightClick("id:project-row >> nth=0")
	screen.WaitFor("id:project-organize-menu", 5*time.Second)
	menu := screen.Find("role:menu").Bounds()
	last := screen.Find("role:menuitem 移除项目").Bounds()
	if last.Origin.Y+last.Size.Height > menu.Origin.Y+menu.Size.Height+1 {
		t.Fatalf("project menu needs scrolling in the narrow window: menu=%+v, last=%+v", menu, last)
	}
	shot(screen, "session-manager/project-menu")
	screen.Press("id:project-organize-menu")
	screen.WaitFor("id:project-sort-menu", 5*time.Second)
	shot(screen, "session-manager/project-organize")
	screen.Key("escape")
	screen.Key("escape")
	screen.RightClick("id:rail-tab-chat")
	screen.WaitFor("text:刷新对话", 5*time.Second)
	shot(screen, "session-manager/rail-menu")
	screen.Key("escape")
	onNativeUI(t, screen, built, func() {
		built.tabs.Set([]string{"managed-00"})
		built.activeID.Set("managed-00")
	})
	screen.WaitFor("id:tab", 5*time.Second)
	screen.RightClick("id:tab")
	screen.WaitFor("id:session-close-tabs-menu", 5*time.Second)
	shot(screen, "session-manager/tab-menu")
}
