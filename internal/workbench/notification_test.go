//go:build !js && !android && !ios

package workbench

// Checks the system notification a finished turn posts: its ID, and the
// press that brings the session back.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestNotificationOpensSession(t *testing.T) {
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "NotifyProject"}},
		Theme: "system", SidebarOpen: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	var built *app
	root := func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}
	screen := nsgotest.Start(t, root, nsgotest.Size(1320, 860))
	screen.Advance(100 * time.Millisecond)
	if built == nil {
		t.Fatal("the app was not built")
	}

	ws := built.workspaces.GetUntracked()[0]
	s := built.makeSession(sessionMeta{ID: "notify-a", Cwd: ws.Path, Title: "通知会话", Updated: time.Now()}, ws.Target)
	built.setupNotifications()
	built.notifyDesktop(sessionNotificationPrefix+s.ID, "PiDeck Lite", "回答好了", nil)
	screen.Advance(100 * time.Millisecond)
	if len(screen.Notifications) != 1 || screen.Notifications[0].ID != "session:notify-a" {
		t.Fatalf("notifications = %v, want session:notify-a", screen.Notifications)
	}

	screen.PressNotification("session:notify-a")
	screen.Advance(100 * time.Millisecond)
	if got := built.activeID.GetUntracked(); got != "notify-a" {
		t.Fatalf("active session = %q, want notify-a", got)
	}
}
