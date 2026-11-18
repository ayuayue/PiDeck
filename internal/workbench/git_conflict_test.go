//go:build !js && !android && !ios

package workbench

// Checks resolving a merge conflict from the Git drawer.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestGitResolveConflict(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")
	dir := t.TempDir()
	file := filepath.Join(dir, "note.txt")
	run := func(args ...string) (string, error) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	must := func(args ...string) string {
		t.Helper()
		out, err := run(args...)
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return out
	}
	must("init")
	must("checkout", "-b", "main")
	if err := os.WriteFile(file, []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	must("add", ".")
	must("commit", "-m", "base")
	must("checkout", "-b", "feature")
	if err := os.WriteFile(file, []byte("feature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	must("commit", "-am", "feature")
	must("checkout", "main")
	if err := os.WriteFile(file, []byte("main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	must("commit", "-am", "main")
	if _, err := run("merge", "feature"); err == nil {
		t.Fatal("the merge should conflict")
	}

	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	cfg, err := json.Marshal(config{Version: 2, Workspaces: []workspaceCfg{{Path: dir, Expanded: true}},
		Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	app.Press("id:git-toggle")
	waitApp(app, "id:git-conflicts", 20*time.Second)
	app.Press("id:git-conflicts")
	app.WaitFor("id:git-ours-0", 10*time.Second)
	app.Press("id:git-ours-0")

	deadline := time.Now().Add(20 * time.Second)
	for {
		data, err := os.ReadFile(file)
		if err == nil && strings.TrimSpace(string(data)) == "main" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("file after ours = %q, %v", string(data), err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	// checkout --ours rewrites the file before git add stages it, so the
	// status can still say UU for a moment after the content changes.
	out := ""
	for time.Now().Before(deadline) {
		out = must("status", "--porcelain")
		if !strings.Contains(out, "UU") {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if strings.Contains(out, "UU") {
		t.Fatalf("status after resolving = %q", out)
	}
	app.WaitForGone("id:git-conflicts", 20*time.Second)
}
