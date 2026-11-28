//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func startFileProjectApp(t *testing.T) (*app, *nsgotest.App, string, string) {
	t.Helper()
	home, first, second := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	disabled := false
	cfg := config{Version: configVersion, Theme: "light", TelemetryEnabled: &disabled,
		Workspaces: []workspaceCfg{{Path: first, Name: "First"}, {Path: second, Name: "Second"}}}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, project := range []struct{ path, text string }{{first, "first project"}, {second, "second project"}} {
		if err := os.WriteFile(filepath.Join(project.path, "shared.txt"), []byte(project.text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		ws := a.workspaceOf(first)
		s := a.blankSession("file-project-session", ws, "File project")
		a.activeID.Set(s.ID)
		a.activeWS.Set(projectWireKey(ws))
		return core.View{Style: ui.FillRest, Children: []core.Node{
			a.projectMenu(s, core.NewSignal(cx, false)), a.drawerFiles(),
		}}
	}, nsgotest.Size(400, 760))
	t.Cleanup(configWrites.Wait)
	t.Cleanup(sessionDraftWrites.Wait)
	t.Cleanup(a.closeDiag)
	screen.WaitFor("role:button shared.txt", 5*time.Second)
	return a, screen, first, second
}

func TestFileDrawerProjectMenuUsesSelectedRoot(t *testing.T) {
	a, screen, first, second := startFileProjectApp(t)
	screen.Press("id:project-chip")
	screen.WaitFor("role:option Second", 5*time.Second)
	screen.Press("role:option Second")
	screen.WaitForGone("role:option Second", 5*time.Second)
	screen.WaitFor("role:button shared.txt", 5*time.Second)
	if len(screen.Query("text:"+filepath.Base(second))) == 0 {
		t.Errorf("selected project %q, but its name is missing from the file drawer", second)
	}
	screen.Press("role:button shared.txt")
	var file *editorFile
	screen.WaitUntil(5*time.Second, func() bool {
		loaded := false
		screen.Post(func() {
			file = a.editor.activeFile()
			loaded = file != nil && !file.Loading.GetUntracked()
		})
		screen.Settle()
		return loaded
	})
	screen.Post(func() {
		if file.Root != second || file.Path != filepath.Join(second, "shared.txt") || file.Text.GetUntracked() != "second project" || file.Err.GetUntracked() != "" {
			t.Errorf("opened file root=%q path=%q text=%q error=%q; want the selected project's file", file.Root, file.Path, file.Text.GetUntracked(), file.Err.GetUntracked())
		}
		if s := a.active(); s == nil || s.WS != first {
			t.Error("selecting a file project changed the existing session's project")
		}
	})
	screen.Settle()
}

func TestFileDrawerFollowsProjectSelection(t *testing.T) {
	a, screen, first, second := startFileProjectApp(t)
	for _, selected := range []string{second, first} {
		screen.Post(func() {
			ws := a.workspaceOf(selected)
			a.openWorkspaceKey(ws.Target.key() + "|" + ws.Path)
		})
		screen.Settle()
		screen.Post(func() {
			if got := a.files.root.GetUntracked(); got != selected {
				t.Errorf("selected project %q, file tree still watches %q", selected, got)
			}
		})
		screen.Settle()
	}
}

func TestFileTreeDropsPreviousProjectRows(t *testing.T) {
	a, screen, _, second := startFileProjectApp(t)
	screen.Post(func() {
		a.files.watch(second)
		if got := a.files.nodes.GetUntracked(); len(got) != 0 {
			t.Errorf("new project exposes the previous project's rows while loading: %+v", got)
		}
	})
	screen.Settle()
	screen.WaitFor("role:button shared.txt", 5*time.Second)
}

func TestFileDrawerSessionChangesStayInTheirProject(t *testing.T) {
	a, screen, first, second := startFileProjectApp(t)
	screen.Post(func() {
		a.active().turns.Set([]turn{{Steps: []turnStep{{Tools: []toolRun{{Action: "编辑", Detail: "shared.txt", Added: 1}}}}}})
	})
	screen.Settle()
	screen.Press("id:files-scope-session")
	screen.WaitFor("id:file-session-row", 5*time.Second)
	screen.Post(func() {
		a.activeWS.Set(projectWireKey(a.workspaceOf(second)))
		a.files.watch(second)
	})
	screen.Settle()
	if got := len(screen.Query("id:file-session-row")); got != 0 {
		t.Errorf("a different project's file browser shows %d session changes", got)
	}
	screen.Post(func() {
		a.activeWS.Set(projectWireKey(a.workspaceOf(first)))
		a.files.watch(first)
	})
	screen.Settle()
	screen.WaitFor("id:file-session-row", 5*time.Second)
}
