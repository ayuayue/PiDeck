//go:build !js && !android && !ios

package workbench

// Checks deleting a local branch from the Git drawer.

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

func TestGitDeleteBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	run("init")
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "first")
	run("branch", "feature")

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
	waitApp(app, "id:git-branch", 20*time.Second)
	app.Press("id:git-branch")
	app.WaitFor("id:git-branch-delete-feature", 10*time.Second)
	app.Press("id:git-branch-delete-feature")
	app.WaitFor("id:confirm-ok", 5*time.Second)
	app.Press("id:confirm-ok")
	deadline := time.Now().Add(10 * time.Second)
	for {
		out, err := exec.Command("git", "-C", dir, "branch", "--list", "feature").CombinedOutput()
		if err == nil && strings.TrimSpace(string(out)) == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("branch still exists: %s, %v", out, err)
		}
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
}

// TestGitStashList pops a stash from the dialog.
func TestGitStashList(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	run("init")
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("first"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "first")
	if err := os.WriteFile(path, []byte("second"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("stash", "push", "-m", "试贮藏")

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
	waitApp(app, "id:git-branch", 20*time.Second)
	app.Press("id:git-more")
	app.WaitFor("text:贮藏列表…", 5*time.Second)
	app.Press("text:贮藏列表…")
	app.WaitFor("id:git-stash-dialog", 5*time.Second)
	app.WaitFor("id:git-stash-row-0", 10*time.Second)
	app.Press("id:git-stash-pop-0")
	deadline := time.Now().Add(10 * time.Second)
	for {
		out, err := exec.Command("git", "-C", dir, "stash", "list").CombinedOutput()
		if err == nil && strings.TrimSpace(string(out)) == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("stash still exists: %s, %v", out, err)
		}
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
}

// TestGitCommitMenu copies a commit's hash from its menu and dialog.
func TestGitCommitMenu(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init")
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "first commit")
	hash := run("rev-parse", "HEAD")

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
	waitApp(app, "id:git-commit-row", 20*time.Second)
	app.RightClick("id:git-commit-row")
	app.WaitFor("text:复制提交说明", 5*time.Second)
	app.WaitFor("text:在浏览器打开提交", 5*time.Second)
	app.Press("text:复制哈希")
	if app.Clipboard != hash {
		t.Fatalf("clipboard = %q, want %q", app.Clipboard, hash)
	}
	app.Press("id:git-commit-row")
	app.WaitFor("id:git-diff", 10*time.Second)
	app.Press("id:git-diff-hash")
	if app.Clipboard != hash {
		t.Fatalf("dialog clipboard = %q, want %q", app.Clipboard, hash)
	}
}

// TestCommitWebURL builds a commit page from common remote shapes.
func TestCommitWebURL(t *testing.T) {
	cases := []struct{ remote, want string }{
		{"https://github.com/acme/shop.git", "https://github.com/acme/shop/commit/abc123"},
		{"git@github.com:acme/shop.git", "https://github.com/acme/shop/commit/abc123"},
		{"ssh://git@github.com/acme/shop.git", "https://github.com/acme/shop/commit/abc123"},
		{"https://gitlab.com/acme/shop.git", "https://gitlab.com/acme/shop/-/commit/abc123"},
		{"git@bitbucket.org:acme/shop.git", "https://bitbucket.org/acme/shop/commits/abc123"},
	}
	for _, c := range cases {
		got, err := commitWebURL(c.remote, "abc123")
		if err != nil || got != c.want {
			t.Errorf("%s = %q, %v; want %q", c.remote, got, err, c.want)
		}
	}
	if _, err := commitWebURL("", "abc"); err == nil {
		t.Error("an empty remote should fail")
	}
	if _, err := commitWebURL("file:///tmp/repo", "abc"); err == nil {
		t.Error("a file remote should fail")
	}
}

// TestGitTags creates and deletes a tag from the dialog.
func TestGitTags(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init")
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "first")

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
	waitApp(app, "id:git-branch", 20*time.Second)
	app.Press("id:git-more")
	app.WaitFor("text:标签…", 5*time.Second)
	app.Press("text:标签…")
	app.WaitFor("id:git-tags", 5*time.Second)
	typeAll(t, app, "id:git-tag-name", "v1.0.0")
	app.Press("id:git-tag-create")
	app.WaitFor("id:git-tag-row-0", 10*time.Second)
	if out := run("tag", "--list", "v1.0.0"); out != "v1.0.0" {
		t.Fatalf("tag = %q", out)
	}
	// The delete action is nested in a scrolling row; activate the button
	// itself so a moving row cannot consume the pointer press.
	app.AccessibilityAction("id:git-tag-delete-0", "activate")
	app.WaitFor("id:confirm-ok", 5*time.Second)
	app.Press("id:confirm-ok")
	deadline := time.Now().Add(10 * time.Second)
	for {
		if run("tag", "--list") == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the tag was not deleted")
		}
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
}

// TestGitRemotes adds and removes a remote from the dialog.
func TestGitRemotes(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init")
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "first")

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
	waitApp(app, "id:git-branch", 20*time.Second)
	app.Press("id:git-more")
	app.WaitFor("text:远端…", 5*time.Second)
	app.Press("text:远端…")
	app.WaitFor("id:git-remotes", 5*time.Second)
	typeAll(t, app, "id:git-remote-url", "https://github.com/acme/shop.git")
	app.Press("id:git-remote-add")
	app.WaitFor("id:git-remote-row-0", 10*time.Second)
	if out := run("remote", "get-url", "origin"); out != "https://github.com/acme/shop.git" {
		t.Fatalf("remote = %q", out)
	}
	app.AccessibilityAction("id:git-remote-delete-0", "activate")
	app.WaitFor("id:confirm-ok", 5*time.Second)
	app.Press("id:confirm-ok")
	deadline := time.Now().Add(10 * time.Second)
	for {
		if run("remote") == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the remote was not removed")
		}
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
}
