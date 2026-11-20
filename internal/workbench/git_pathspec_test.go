//go:build !js && !android && !ios

package workbench

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// A route named [ab] is a real directory, not a request to also operate on a.
func TestGitFileActionsUseLiteralPaths(t *testing.T) {
	const selected, sibling = "[ab]/note.txt", "a/note.txt"
	tests := []struct {
		name         string
		args         []string
		staged       bool
		wantStaged   string
		wantSelected string
	}{
		{"stage", []string{"add", "--", selected}, false, selected, "changed\n"},
		{"unstage", []string{"restore", "--staged", "--", selected}, true, sibling, "changed\n"},
		{"discard", []string{"restore", "--staged", "--worktree", "--", selected}, true, sibling, "base\n"},
		{"discard fallback", []string{"checkout", "HEAD", "--", selected}, true, sibling, "base\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := newGitPathspecFixture(t)
			for _, path := range []string{selected, sibling} {
				writeGitPathspecFile(t, g, path, "base\n")
			}
			mustGitPathspec(t, g, "add", "-A")
			mustGitPathspec(t, g, "commit", "-m", "base")
			for _, path := range []string{selected, sibling} {
				writeGitPathspecFile(t, g, path, "changed\n")
			}
			if tt.staged {
				mustGitPathspec(t, g, "add", "-A")
			}

			mustGitPathspec(t, g, tt.args...)
			got := mustGitPathspec(t, g, "diff", "--cached", "--name-only", "-z")
			if want := tt.wantStaged + "\x00"; got != want {
				t.Errorf("staged paths = %q, want %q", got, want)
			}
			for path, want := range map[string]string{selected: tt.wantSelected, sibling: "changed\n"} {
				got, err := os.ReadFile(filepath.Join(g.path, filepath.FromSlash(path)))
				if err != nil || string(got) != want {
					t.Errorf("worktree %q = %q, %v; want %q", path, got, err, want)
				}
			}
		})
	}
}

func TestGitCleanUsesLiteralPaths(t *testing.T) {
	g := newGitPathspecFixture(t)
	const selected, sibling = "[ab]/note.txt", "a/note.txt"
	for _, path := range []string{selected, sibling} {
		writeGitPathspecFile(t, g, path, "keep the other file\n")
	}
	mustGitPathspec(t, g, "clean", "-f", "-d", "--", selected)
	if _, err := os.Stat(filepath.Join(g.path, filepath.FromSlash(selected))); !os.IsNotExist(err) {
		t.Errorf("selected untracked file still exists: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(g.path, filepath.FromSlash(sibling)))
	if err != nil || string(got) != "keep the other file\n" {
		t.Errorf("unselected file = %q, %v; want its original contents", got, err)
	}
}

func TestGitUnbornUnstageUsesLiteralPaths(t *testing.T) {
	g := newGitPathspecFixture(t)
	const selected, sibling = "[ab]/note.txt", "a/note.txt"
	for _, path := range []string{selected, sibling} {
		writeGitPathspecFile(t, g, path, "new\n")
	}
	mustGitPathspec(t, g, "add", "-A")
	mustGitPathspec(t, g, "rm", "--cached", "-r", "-q", "--", selected)
	if got := mustGitPathspec(t, g, "ls-files", "-z"); got != sibling+"\x00" {
		t.Errorf("index paths = %q, want only %q", got, sibling)
	}
	for _, path := range []string{selected, sibling} {
		if got, err := os.ReadFile(filepath.Join(g.path, filepath.FromSlash(path))); err != nil || string(got) != "new\n" {
			t.Errorf("worktree %q = %q, %v; want unchanged contents", path, got, err)
		}
	}
}

func TestGitLiteralPathsKeepAllFileActions(t *testing.T) {
	g := newGitPathspecFixture(t)
	paths := []string{"[ab]/note.txt", "a/note.txt"}
	for _, path := range paths {
		writeGitPathspecFile(t, g, path, "base\n")
	}
	mustGitPathspec(t, g, "add", "-A")
	mustGitPathspec(t, g, "commit", "-m", "base")
	for _, path := range paths {
		writeGitPathspecFile(t, g, path, "changed\n")
	}
	mustGitPathspec(t, g, "add", "-A")
	wantAll := strings.Join(paths, "\x00") + "\x00"
	if got := mustGitPathspec(t, g, "diff", "--cached", "--name-only", "-z"); got != wantAll {
		t.Errorf("stage all paths = %q, want %q", got, wantAll)
	}
	mustGitPathspec(t, g, "restore", "--staged", "--", ".")
	if got := mustGitPathspec(t, g, "diff", "--cached", "--name-only", "-z"); got != "" {
		t.Errorf("index after unstage all = %q, want empty", got)
	}
	for _, path := range paths {
		writeGitPathspecFile(t, g, path+".new", "untracked\n")
	}
	mustGitPathspec(t, g, "restore", "--staged", "--worktree", "--", ".")
	mustGitPathspec(t, g, "clean", "-f", "-d", "--", ".")
	if got := mustGitPathspec(t, g, "status", "--porcelain"); got != "" {
		t.Errorf("status after discard all = %q, want clean", got)
	}
	for _, path := range paths {
		if got, err := os.ReadFile(filepath.Join(g.path, filepath.FromSlash(path))); err != nil || string(got) != "base\n" {
			t.Errorf("tracked file %q = %q, %v; want original contents", path, got, err)
		}
	}
}

func TestGitDiffAndHistoryUseLiteralPaths(t *testing.T) {
	const selected, sibling = "[ab]/note.txt", "a/note.txt"
	g := newGitPathspecFixture(t)
	for _, path := range []string{selected, sibling} {
		writeGitPathspecFile(t, g, path, "base\n")
	}
	mustGitPathspec(t, g, "add", "-A")
	mustGitPathspec(t, g, "commit", "-m", "base")
	writeGitPathspecFile(t, g, sibling, "sibling only\n")
	mustGitPathspec(t, g, "commit", "-am", "sibling only")
	for _, path := range []string{selected, sibling} {
		writeGitPathspecFile(t, g, path, "changed\n")
	}
	for _, staged := range []bool{false, true} {
		args := []string{"diff", "--no-color"}
		if staged {
			mustGitPathspec(t, g, "add", "-A")
			args = append(args, "--cached")
		}
		args = append(args, "--", selected)
		out := mustGitPathspec(t, g, args...)
		if got := diffFiles(out); !reflect.DeepEqual(got, []string{selected}) {
			t.Errorf("staged=%v: patch paths = %q, want only %q", staged, got, selected)
		}
	}
	commits, err := readFileHistory(localTarget, g.path, selected, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(commits) != 1 || commits[0].Subject != "base" {
		t.Errorf("selected file history = %+v, want only the base commit", commits)
	}
}

func TestGitCommandUsesLiteralPathsOnEveryTarget(t *testing.T) {
	for _, target := range []target{localTarget, {Kind: targetWSL, Distro: "Ubuntu"}, {Kind: targetSSH, Host: "example.invalid"}} {
		t.Run(target.key(), func(t *testing.T) {
			args := []string{"add", "--", "[ab]/note.txt"}
			cmd := gitCommand(context.Background(), target, "/project", args...)
			if target.Kind == targetSSH {
				if script := cmd.Args[len(cmd.Args)-1]; !strings.Contains(script, "git "+shellJoin(append([]string{"--literal-pathspecs"}, args...))) {
					t.Errorf("SSH command does not enforce literal pathspecs: %q", script)
				}
			} else {
				got := cmd.Args[len(cmd.Args)-4:]
				want := append([]string{"--literal-pathspecs"}, args...)
				if !reflect.DeepEqual(got, want) {
					t.Errorf("Git arguments = %q, want %q", got, want)
				}
			}
			if !reflect.DeepEqual(args, []string{"add", "--", "[ab]/note.txt"}) {
				t.Errorf("caller's arguments were modified: %q", args)
			}
		})
	}
}

func newGitPathspecFixture(t *testing.T) gitRunner {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	g := gitRunner{t: localTarget, path: t.TempDir()}
	for key, value := range map[string]string{
		"GIT_CONFIG_GLOBAL":   filepath.Join(g.path, "no-global-config"),
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_AUTHOR_NAME":     "PiDeck Test", "GIT_AUTHOR_EMAIL": "pideck@example.com",
		"GIT_COMMITTER_NAME": "PiDeck Test", "GIT_COMMITTER_EMAIL": "pideck@example.com",
		"GIT_LITERAL_PATHSPECS": "0", "GIT_GLOB_PATHSPECS": "0",
		"GIT_NOGLOB_PATHSPECS": "0", "GIT_ICASE_PATHSPECS": "0",
	} {
		t.Setenv(key, value)
	}
	mustGitPathspec(t, g, "init", "--template=")
	mustGitPathspec(t, g, "config", "core.autocrlf", "false")
	return g
}

func mustGitPathspec(t *testing.T, g gitRunner, args ...string) string {
	t.Helper()
	out, err := g.exec(10*time.Second, args...)
	if err != nil {
		t.Fatalf("git %q: %v", args, err)
	}
	return out
}

func writeGitPathspecFile(t *testing.T, g gitRunner, path, contents string) {
	t.Helper()
	path = filepath.Join(g.path, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}
