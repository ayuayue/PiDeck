//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionRowsNameACPAgentsAndHidePi(t *testing.T) {
	project := t.TempDir()
	built, screen := railFixture(t, project)
	waitProjects(t, screen, 1)
	presetDir := filepath.Join(built.st.dir, "acp")
	if err := os.MkdirAll(presetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(presetDir, "presets.json"), []byte(`{"presets":[{"id":"custom","name":"Custom Agent","command":"unused"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}

	var changing *session
	screen.Post(func() {
		ws := built.workspaceOf(project)
		var sessions []*session
		for _, row := range []struct{ id, backend, preset string }{
			{"default-pi", "", ""},
			{"explicit-pi", "pi", ""},
			{"builtin-acp", "acp", "claude"},
			{"custom-acp", "acp", "custom"},
			{"missing-acp", "acp", "removed-agent"},
		} {
			s := built.blankSession(row.id, ws, row.id)
			s.backend, s.acpPreset = row.backend, row.preset
			sessions = append(sessions, s)
			if row.id == "default-pi" {
				changing = s
			}
		}
		ws.Sessions.Set(sessions)
	})
	screen.WaitUntil(5*time.Second, func() bool {
		return screen.Exists("id:session-row >> text:Claude Agent") &&
			screen.Exists("id:session-row >> text:Custom Agent") &&
			screen.Exists("id:session-row >> text:removed-agent")
	})
	if got := len(screen.Query("id:session-agent")); got != 3 {
		t.Fatalf("five sessions show %d agent labels, want only the three ACP labels", got)
	}

	// Backend choices invalidate the session's existing UI revision; the
	// row must follow it even before a process has been started.
	screen.Post(func() {
		changing.backend, changing.acpPreset = "acp", "custom"
		changing.uiSeq.Update(func(v int) int { return v + 1 })
	})
	screen.WaitUntil(5*time.Second, func() bool {
		return len(screen.Query("id:session-row >> text:Custom Agent")) == 2
	})
	screen.Post(func() {
		changing.backend, changing.acpPreset = "", ""
		changing.uiSeq.Update(func(v int) int { return v + 1 })
	})
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:session-agent")) == 3 })
}
