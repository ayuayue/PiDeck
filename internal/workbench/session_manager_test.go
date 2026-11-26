//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func sessionManagerFixture(t *testing.T, count int) (*app, *nsgotest.App, *workspace) {
	t.Helper()
	project := t.TempDir()
	built, screen := railFixture(t, project, t.TempDir())
	t.Cleanup(configWrites.Wait)
	waitProjects(t, screen, 2)
	var ws *workspace
	screen.Post(func() {
		ws = built.workspaceOf(project)
		var sessions []*session
		for i := 0; i < count; i++ {
			s := built.makeSession(sessionMeta{ID: fmt.Sprintf("managed-%02d", i), Cwd: project,
				Title: fmt.Sprintf("会话 %02d", i), Updated: time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC).Add(-time.Duration(i) * time.Hour)}, ws.Target)
			if i%2 == 1 {
				s.backend, s.acpPreset = "acp", "codex"
			}
			sessions = append(sessions, s)
		}
		ws.Sessions.Set(sessions)
		if count > 0 {
			// The same session can appear in the internal and external listing.
			ws.Pi.Set([]*session{sessions[0]})
		}
		other := built.projects()[1]
		if other == ws {
			other = built.projects()[0]
		}
		s := built.makeSession(sessionMeta{ID: "other-project", Cwd: other.Path, Title: "另一个项目"}, other.Target)
		other.Sessions.Set([]*session{s})
		built.openSessionManager(ws, false)
	})
	screen.WaitFor("id:session-manager", 5*time.Second)
	return built, screen, ws
}

func TestSessionManagerPagingFilteringAndSelection(t *testing.T) {
	built, screen, _ := sessionManagerFixture(t, 45)
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:managed-session-row")) == sessionManagerPageSize })
	screen.Press("id:managed-select-managed-00")
	screen.Press("role:button 下一页")
	screen.WaitFor("id:managed-select-managed-20", 5*time.Second)
	screen.Press("id:managed-select-managed-20")
	screen.Post(func() {
		if got := len(built.sessionManager.selected.GetUntracked()); got != 2 {
			t.Errorf("cross-page selection = %d, want 2", got)
		}
	})
	screen.Press("id:session-manager-agent")
	screen.WaitFor("id:session-manager-agent-1", 5*time.Second)
	screen.Press("id:session-manager-agent-1")
	screen.WaitFor("id:managed-select-managed-01", 5*time.Second)
	screen.Post(func() {
		if got := built.sessionManager.page.GetUntracked(); got != 1 {
			t.Errorf("page after filter = %d, want 1", got)
		}
		if got := len(built.sessionManager.selected.GetUntracked()); got != 0 {
			t.Errorf("selection after filter = %d, want 0", got)
		}
		for _, s := range built.managedSessions() {
			if s.backend != "acp" || s.acpPreset != "codex" || s.ID == "other-project" {
				t.Errorf("unexpected filtered session %q (%s/%s)", s.ID, s.backend, s.acpPreset)
			}
		}
	})
	screen.Type("id:session-manager-query", "会话 43")
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:managed-session-row")) == 1 })
	screen.WaitFor("id:managed-select-managed-43", 5*time.Second)
	screen.Post(func() { built.setSessionManagerQuery("没有匹配的关键词") })
	screen.WaitFor("id:session-manager-empty", 5*time.Second)
	screen.Post(func() {
		built.setSessionManagerQuery("")
		built.setSessionManagerAgent("")
		built.sessionManager.page.Set(3)
	})
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:managed-session-row")) == 5 })
}

func TestSessionManagerArchiveAndRestore(t *testing.T) {
	built, screen, ws := sessionManagerFixture(t, 3)
	screen.Press("id:managed-select-managed-00")
	screen.Press("id:managed-select-managed-01")
	screen.Press("id:session-manager-archive")
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:managed-session-row")) == 1 })
	screen.Post(func() {
		if !built.sessionArchived("managed-00") || !built.sessionArchived("managed-01") {
			t.Error("batch archive did not persist both selected IDs")
		}
		if len(ws.Sessions.GetUntracked()) != 3 {
			t.Error("archiving removed session records")
		}
	})
	screen.Press("id:session-manager-show-archived")
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:managed-session-row")) == 2 })
	screen.Press("id:session-manager-select-page")
	screen.Press("id:session-manager-restore")
	screen.WaitFor("id:session-manager-empty", 5*time.Second)
	screen.Post(func() {
		if built.sessionArchived("managed-00") || built.sessionArchived("managed-01") {
			t.Error("batch restore left archived IDs behind")
		}
	})
}

func TestSessionManagerDeleteConfirmationAndExternalProtection(t *testing.T) {
	built, screen, _ := sessionManagerFixture(t, 3)
	for _, id := range []string{"managed-00", "managed-01"} {
		s := built.byID[id]
		file := filepath.Join(built.st.dir, "sessions", id+".jsonl")
		if s.backend == "acp" {
			file = filepath.Join(built.acpArchiveDir(), archiveName(id))
		}
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("history "+id), 0o600); err != nil {
			t.Fatal(err)
		}
		screen.Post(func() { s.File = file })
	}
	screen.Post(func() { built.byID["managed-02"].External = true })
	screen.Press("id:managed-select-managed-02")
	screen.Post(func() { built.askDeleteManagedSessions() })
	screen.Settle()
	if len(screen.Query("id:session-manager-delete-confirm")) != 0 {
		t.Fatal("an external pi session reached delete confirmation")
	}
	screen.Press("id:managed-select-managed-02")
	screen.Press("id:managed-select-managed-00")
	screen.Press("id:managed-select-managed-01")
	screen.Press("id:session-manager-delete")
	screen.WaitFor("id:session-manager-delete-confirm", 5*time.Second)
	screen.Post(func() {
		if built.byID["managed-00"] == nil || built.byID["managed-01"] == nil {
			t.Error("sessions were deleted before confirmation")
		}
		built.setSessionManagerQuery("must not change the confirmed selection")
		built.toggleManagedSession("managed-02", true)
		if built.sessionManager.query.GetUntracked() != "" || len(built.sessionManager.selected.GetUntracked()) != 2 {
			t.Error("confirmation allowed filters or selection to change")
		}
	})
	screen.Press("id:session-manager-delete-cancel")
	screen.WaitForGone("id:session-manager-delete-confirm", 5*time.Second)
	screen.Press("id:session-manager-delete")
	screen.Press("id:session-manager-delete-ok")
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:managed-session-row")) == 1 })
	screen.Post(func() {
		if built.byID["managed-00"] != nil || built.byID["managed-01"] != nil || built.byID["managed-02"] == nil {
			t.Error("batch deletion did not remove exactly the selected owned sessions")
		}
	})
	files, err := filepath.Glob(filepath.Join(built.st.dir, "trash", "*.jsonl"))
	if err != nil || len(files) != 2 {
		t.Fatalf("trash files = %v, error = %v, want both pi and ACP histories", files, err)
	}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil || !strings.HasPrefix(string(data), "history managed-0") {
			t.Fatalf("trash content = %q, error = %v", data, err)
		}
	}
}

func TestSessionManagerDeleteFailureKeepsSelectionForRetry(t *testing.T) {
	built, screen, _ := sessionManagerFixture(t, 1)
	file := filepath.Join(built.st.dir, "owned-history.jsonl")
	if err := os.WriteFile(file, []byte("keep this history"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A file where the trash directory belongs fails immediately on every
	// platform, without relying on permissions or a held Windows handle.
	blocker := filepath.Join(built.st.dir, "trash")
	if err := os.WriteFile(blocker, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	screen.Post(func() { built.byID["managed-00"].File = file })
	screen.Press("id:managed-select-managed-00")
	screen.Press("id:session-manager-delete")
	screen.Press("id:session-manager-delete-ok")
	screen.WaitUntil(5*time.Second, func() bool {
		done := false
		screen.Post(func() {
			done = !built.sessionManager.busy.GetUntracked() && strings.Contains(built.sessionManager.message.GetUntracked(), "1 个失败")
		})
		screen.Settle()
		return done
	})
	screen.Post(func() {
		if built.byID["managed-00"] == nil || !built.sessionManager.selected.GetUntracked()["managed-00"] {
			t.Error("failed deletion lost its session or selection")
		}
	})
	if data, err := os.ReadFile(file); err != nil || string(data) != "keep this history" {
		t.Fatalf("failed deletion changed the history: %q, %v", data, err)
	}
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	screen.Press("id:session-manager-delete")
	screen.Press("id:session-manager-delete-ok")
	screen.WaitFor("id:session-manager-empty", 5*time.Second)
}
