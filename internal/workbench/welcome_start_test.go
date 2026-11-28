//go:build !js && !android && !ios

package workbench

import (
	"testing"
	"time"

	"example.com/pideck/internal/apptext"
)

func TestWelcomeProjectStartsRealSession(t *testing.T) {
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	a, screen, original := chatDesignFixture(t, 0)
	var project *workspace
	screen.Post(func() {
		project = a.workspaceFor(original.Target, original.WS)
		a.tabs.Set(nil)
		a.activeID.Set("")
	})
	screen.WaitFor("id:welcome-projects", 5*time.Second)
	if project == nil {
		t.Fatal("the fixture must have a project")
	}
	row := "id:welcome-project-" + project.key()
	screen.Focus(row)
	screen.Key("Return")
	screen.WaitFor("id:chat-start", 5*time.Second)
	screen.WaitForGone("id:welcome-projects", 5*time.Second)
	screen.Post(func() {
		created := a.byID[a.activeID.GetUntracked()]
		if created == nil || created == original {
			t.Fatal("the welcome project action should create and select a new session")
		}
		if created.WS != project.Path || created.Target != project.Target {
			t.Errorf("session project = %v %q, want %v %q", created.Target, created.WS, project.Target, project.Path)
		}
		if len(created.turns.GetUntracked()) != 0 {
			t.Error("opening a project must not send a message")
		}
	})
	screen.Settle()
}

func TestWelcomeDoesNotCountChatAsProject(t *testing.T) {
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	a, screen, original := chatDesignFixture(t, 0)
	screen.Post(func() {
		for _, ws := range a.workspaces.GetUntracked() {
			ws.Chat = true
		}
		a.tabs.Set(nil)
		a.activeID.Set("")
		// Keep the former active project selected to cover the fallback.
		a.activeWS.Set(original.WS)
	})
	screen.WaitFor("id:welcome-primary", 5*time.Second)
	screen.WaitFor("text:先添加一个项目文件夹，再开会话。", 5*time.Second)
	screen.WaitForGone("id:welcome-projects", 5*time.Second)
	screen.Resize(760, 620)
	screen.WaitFor("id:welcome", 5*time.Second)
	viewport := screen.Find("id:welcome").Bounds()
	for _, id := range []string{"welcome-primary", "welcome-chat", "welcome-secondary"} {
		button := screen.Find("id:" + id).Bounds()
		if button.Origin.X < viewport.Origin.X || button.Origin.X+button.Size.Width > viewport.Origin.X+viewport.Size.Width {
			t.Errorf("%s %v overflows the welcome surface %v", id, button, viewport)
		}
	}
}
