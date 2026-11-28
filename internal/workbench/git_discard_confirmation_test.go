//go:build !js && !android && !ios

package workbench

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestGitDiscardConfirmationDoesNotCrossProject(t *testing.T) {
	first := t.TempDir()
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")
	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	run(first, "init")
	firstFile := filepath.Join(first, "initial.txt")
	if err := os.WriteFile(firstFile, []byte("staged initial content\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	run(first, "add", ".")

	second, _ := gitFixture(t)
	secondFile := filepath.Join(second, "note.txt")
	untracked := filepath.Join(second, "keep.txt")
	if err := os.WriteFile(untracked, []byte("keep this untracked file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a, screen := startGitStatusApp(t, config{DrawerOpen: true, DrawerTab: "git",
		Workspaces: []workspaceCfg{{Path: first, Name: "Initial"}, {Path: second, Name: "Second"}}})
	screen.WaitUntil(20*time.Second, func() bool {
		st := a.git.state.GetUntracked()
		return !a.git.working && st.IsRepo && st.Initial && len(st.Files) > 0
	})
	screen.Press("id:git-discard-all")
	screen.WaitFor("id:confirm-ok", 5*time.Second)

	// Model a workspace change reaching the owner while the old confirmation is pending.
	screen.Post(func() { a.openWorkspaceKey(localTarget.key() + "|" + second) })
	screen.Settle()
	screen.WaitUntil(20*time.Second, func() bool {
		st := a.git.state.GetUntracked()
		return !a.git.working && len(st.Files) == 1 && st.Files[0].Untracked
	})
	screen.Post(a.confirm)
	screen.Settle()
	screen.WaitUntil(20*time.Second, func() bool { return !a.git.running && !a.git.working })
	for _, path := range []string{firstFile, secondFile, untracked} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("confirmation for the first project changed %s: %v", filepath.Base(path), err)
		}
	}
}

func TestGitDiscardUsesUpdatedRepositoryState(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	run("init")
	file := filepath.Join(dir, "committed.txt")
	if err := os.WriteFile(file, []byte("committed content\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	run("add", ".")

	a, screen := startGitStatusApp(t, config{DrawerOpen: true, DrawerTab: "git",
		Workspaces: []workspaceCfg{{Path: dir, Name: "Initial"}}})
	screen.WaitUntil(20*time.Second, func() bool {
		return !a.git.working && a.git.state.GetUntracked().IsRepo
	})
	if st := a.git.state.GetUntracked(); !st.Initial || len(st.Files) == 0 {
		t.Fatalf("pre-confirm repository state = %+v, want staged initial-repository changes", st)
	}
	screen.Press("id:git-discard-all")
	screen.WaitFor("id:confirm-ok", 5*time.Second)

	// A commit can finish in another local Git client while the modal is open.
	run("commit", "-m", "commit while confirmation is open")
	untracked := filepath.Join(dir, "new-untracked.txt")
	if err := os.WriteFile(untracked, []byte("new untracked content\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	screen.Advance(4 * time.Second)
	screen.WaitUntil(10*time.Second, func() bool {
		st := a.git.state.GetUntracked()
		return !a.git.working && !st.Initial && len(st.Files) == 1 && st.Files[0].Untracked
	})
	screen.Press("id:confirm-ok")
	screen.WaitUntil(20*time.Second, func() bool { return !a.git.running && !a.git.working })
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("file committed while confirmation was open was removed: %v", err)
	}
	if _, err := os.Stat(untracked); !os.IsNotExist(err) {
		t.Fatalf("untracked file was not discarded: stat error = %v", err)
	}
}
