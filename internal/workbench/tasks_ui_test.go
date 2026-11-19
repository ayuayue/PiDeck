//go:build !js && !android && !ios

package workbench

// A smoke test for the three new windows and saving one task without a
// real agent process.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// TestTaskFavoritesAgentWindows opens each dialog and saves a task.
func TestTaskFavoritesAgentWindows(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home, workspace := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, _ := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "TaskProject"}},
		Theme: "system", SidebarOpen: true})
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1320, 860))
	screen.Advance(200 * time.Millisecond)
	if built == nil {
		t.Fatal("the app did not start")
	}

	built.openFavorites()
	screen.Advance(100 * time.Millisecond)
	if len(screen.Query("id:favorites-dialog")) == 0 {
		t.Error("the favorites dialog did not open")
	}
	built.favOpen.Set(false)

	built.openAgentManager()
	screen.Advance(100 * time.Millisecond)
	if len(screen.Query("id:agent-manager")) == 0 {
		t.Error("the agent manager did not open")
	}
	built.agentManageOpen.Set(false)

	built.openTaskForm()
	screen.Advance(100 * time.Millisecond)
	if len(screen.Query("id:task-form")) == 0 {
		t.Error("the task form did not open")
	}
	built.taskName.Set("每日整理")
	built.taskCron.Set("0 9 * * *")
	built.taskPrompt.Set("把今天的改动整理成一段说明")
	built.taskProject.Set(workspace)
	built.taskBackend.Set("pi")
	built.taskEnabled.Set(true)
	built.saveTaskForm()
	screen.Advance(100 * time.Millisecond)
	list := built.taskList()
	if len(list) != 1 || list[0].Name != "每日整理" || list[0].Cron != "0 9 * * *" {
		t.Fatalf("tasks = %+v", list)
	}
	if _, err := os.Stat(filepath.Join(home, "tasks.json")); err != nil {
		t.Fatalf("tasks.json not written: %v", err)
	}
	// The form stays open on the task it saved, and saving again edits it
	// instead of adding a second one.
	if !built.taskFormOpen.GetUntracked() {
		t.Error("saving closed the task form")
	}
	if got := built.taskEditID.GetUntracked(); got != list[0].ID {
		t.Errorf("the form edits %q after saving, want %q", got, list[0].ID)
	}
	built.taskName.Set("每日整理（二）")
	built.saveTaskForm()
	if got := built.taskList(); len(got) != 1 || got[0].Name != "每日整理（二）" {
		t.Fatalf("saving twice produced %+v", got)
	}
	built.openTaskDialog()
	screen.Advance(100 * time.Millisecond)
	if len(screen.Query("id:task-row-"+list[0].ID)) == 0 {
		t.Error("the saved task is not listed")
	}

	// The ACP backend keeps the preset the form chose.
	built.editTask(list[0].ID)
	built.taskBackend.Set("acp")
	built.taskPreset.Set("claude")
	built.saveTaskForm()
	list = built.taskList()
	if len(list) != 1 || list[0].Backend != "acp" || list[0].ACPPreset != "claude" {
		t.Fatalf("ACP task = %+v", list)
	}

	// A saved reply and a session reference survive in favorites.json.
	ws := built.workspaceOf(workspace)
	if ws == nil {
		t.Fatal("the workspace is missing")
	}
	s := built.blankSession("favorite-test", ws, "收藏测试")
	s.turns.Set([]turn{{ID: "t1", Prompt: "问题", Status: chat.Completed, Final: "回答正文"}})
	built.favoriteReply(s, s.turns.GetUntracked()[0])
	built.favoriteSession(s)
	if got := built.favoriteCount(); got != 2 {
		t.Fatalf("favorites = %d", got)
	}
	if _, err := os.Stat(filepath.Join(home, "favorites.json")); err != nil {
		t.Fatalf("favorites.json not written: %v", err)
	}

	// The agent manager writes custom.json.
	built.openAgentManager()
	built.agentEditKey.Set("review-helper")
	built.agentEditName.Set("审查助手")
	built.agentEditPrompt.Set("先找问题。")
	built.saveAgentForm()
	if !built.isCustomAgent("review-helper") {
		t.Error("the custom agent was not saved")
	}
}
