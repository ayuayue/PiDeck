//go:build !js && !android && !ios

package workbench

// Checks committing and pushing in one action.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestGitCommitAndPush(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, run := gitFixture(t)
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("push test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")

	app := startGitApp(t, dir)
	app.WaitFor("id:git-commit-push", 20*time.Second)
	app.Focus("id:git-commit-message")
	typeAll(t, app, "id:git-commit-message", "push me")
	app.Press("id:git-commit-push")

	deadline := time.Now().Add(30 * time.Second)
	for {
		local := strings.TrimSpace(run("rev-parse", "HEAD"))
		remote := strings.Fields(run("ls-remote", "origin", "refs/heads/main"))
		subject := strings.TrimSpace(run("log", "-1", "--pretty=%s"))
		if local != "" && len(remote) > 0 && remote[0] == local && subject == "push me" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("local = %q, remote = %v, subject = %q", local, remote, subject)
		}
		time.Sleep(100 * time.Millisecond)
	}
}
