//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGitCommitPreservesEditedDraft(t *testing.T) {
	for _, tc := range []struct {
		name        string
		amend, edit bool
		nextMessage string
		nextAmend   bool
		fail        bool
	}{
		{name: "unchanged"},
		{name: "new-message", edit: true, nextMessage: "next commit"},
		{name: "amend-enabled", edit: true, nextMessage: "  submitted message\n", nextAmend: true},
		{name: "amend-disabled", amend: true, edit: true, nextMessage: "  submitted message\n"},
		{name: "new-message-and-amend", edit: true, nextMessage: "next commit", nextAmend: true},
		{name: "failed-commit", fail: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir, run := gitFixture(t)
			if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("draft test\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			run("add", "note.txt")
			if tc.fail {
				if err := os.WriteFile(filepath.Join(dir, ".git", "hooks", "pre-commit"), []byte("#!/bin/sh\nexit 1\n"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			a, screen := startGitStatusApp(t, config{Workspaces: []workspaceCfg{{Path: dir}}})
			screen.WaitUntil(10*time.Second, func() bool { return !a.git.working })
			const draft = "  submitted message\n"
			screen.Post(func() {
				a.git.msg.Set(draft)
				a.git.amend.Set(tc.amend)
				a.gitCommit(false, tc.amend)
				// Both edits precede every posted completion, even if Git is fast.
				if tc.edit {
					a.git.msg.Set(tc.nextMessage)
					a.git.amend.Set(tc.nextAmend)
				}
			})
			screen.Settle()
			screen.WaitUntil(10*time.Second, func() bool { return !a.git.running && !a.git.working })
			wantMessage, wantAmend := "", false
			if tc.edit {
				wantMessage, wantAmend = tc.nextMessage, tc.nextAmend
			} else if tc.fail {
				wantMessage, wantAmend = draft, tc.amend
			}
			if got := a.git.msg.GetUntracked(); got != wantMessage || a.git.amend.GetUntracked() != wantAmend {
				t.Errorf("draft after completion = %q amend=%v, want %q amend=%v", got, a.git.amend.GetUntracked(), wantMessage, wantAmend)
			}
			if tc.fail {
				if a.git.err.GetUntracked() == "" {
					t.Fatal("rejected commit did not report an error")
				}
			} else if got := strings.TrimSpace(run("log", "-1", "--pretty=%s")); got != "submitted message" {
				t.Fatalf("committed message = %q, want submitted message", got)
			}
		})
	}
}
