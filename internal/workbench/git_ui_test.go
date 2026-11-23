//go:build !js && !android && !ios

package workbench

// Checks the Git drawer against a real temporary repository: reading a
// folder that is not one, initializing it, staging a file and committing.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestGitDrawer drives the Git panel through a repository's first commit.
func TestGitDrawer(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	requirePi(t)
	// Identity and an English locale make the commit deterministic.
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello git"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The workspace is in the config, so the test needs no folder picker
	// and runs the same in a window as headless.
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: dir, Expanded: true}},
		Theme: "system", SidebarOpen: true, ScanPi: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	app.Press("id:git-toggle")
	app.WaitFor("text:这个项目还不是 Git 仓库", 5*time.Second)
	app.Press("text:初始化 Git 仓库")
	waitApp(app, "text:note.txt", 20*time.Second)
	waitApp(app, "id:git-stage", 20*time.Second)
	// The file tree marks the untracked file with "?".
	app.Press("id:drawer-tab-files")
	waitApp(app, "id:file-git-mark", 10*time.Second)
	app.Press("id:drawer-tab-git")
	waitApp(app, "id:git-stage", 10*time.Second)
	// The row opens the untracked file's patch.
	app.Press("id:git-file")
	waitApp(app, "id:git-diff", 20*time.Second)
	app.Advance(300 * time.Millisecond)
	shot(app, "40-git-diff")
	// The patch is a pane now: its tab closes it.
	app.Press("id:pane-tab-close-diff")
	app.WaitForGone("id:git-diff", 5*time.Second)
	// The action sits inside a scrolling row. Pointer hit testing can land
	// on the row around it as the drawer settles, so activate the control
	// directly and keep this test focused on the Git operation and refresh.
	app.AccessibilityAction("id:git-stage", "activate")
	waitApp(app, "text:已暂存 1", 20*time.Second)

	app.Type("id:git-commit-message", "第一次提交")
	app.Press("id:git-commit")
	waitApp(app, "id:git-commit-row", 30*time.Second)
	app.Settle()
	if got := app.Find("id:git-commit-message").Text; got != "" {
		t.Fatalf("commit message = %q, want cleared", got)
	}
	app.Advance(300 * time.Millisecond)
	shot(app, "40-git")

	// The history filter keeps only matching commits.
	app.Type("id:git-log-search", "第一次")
	waitApp(app, "id:git-commit-row", 10*time.Second)
	app.Type("id:git-log-search", "不存在")
	waitApp(app, "text:没有匹配的提交", 10*time.Second)
	app.Clear("id:git-log-search")
	waitApp(app, "id:git-commit-row", 10*time.Second)

	// Outside changes show up on their own: one staged, one in the
	// worktree.
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello git again"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "second.txt"), []byte("another file"), 0o644); err != nil {
		t.Fatal(err)
	}
	add := exec.Command("git", "-C", dir, "add", "second.txt")
	if out, err := add.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v: %s", err, out)
	}
	// The panel rereads the status on its timer.
	app.Advance(5 * time.Second)
	waitApp(app, "id:git-staged-file", 20*time.Second)
	waitApp(app, "id:git-file", 20*time.Second)
	app.Advance(300 * time.Millisecond)
	shot(app, "42-git-changes")
}
