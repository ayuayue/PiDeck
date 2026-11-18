//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"testing"
	"time"

	"example.com/pideck-lite/internal/viewkit"
)

// TestParseGitStatus reads porcelain v2's records: branch, ahead/behind,
// staged, unstaged, renamed, conflicted and untracked paths.
func TestParseGitStatus(t *testing.T) {
	records := []string{
		"# branch.oid 0123456789abcdef",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +2 -1",
		"1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb dir/work.go",
		"1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb staged.txt",
		"2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 renamed.txt",
		"old-name.txt",
		"u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict.txt",
		"? new file.txt",
	}
	st := parseGitStatus(strings.Join(records, "\x00") + "\x00")
	if !st.IsRepo {
		t.Fatal("IsRepo = false")
	}
	if st.Branch != "main" || st.Upstream != "origin/main" || st.Ahead != 2 || st.Behind != 1 {
		t.Fatalf("branch = %+v", st)
	}
	if len(st.Files) != 5 {
		t.Fatalf("files = %d, want 5", len(st.Files))
	}
	if got := st.stagedCount(); got != 2 {
		t.Errorf("staged = %d, want 2", got)
	}
	if got := st.changedCount(); got != 3 {
		t.Errorf("unstaged = %d, want 3", got)
	}
	byPath := map[string]gitFile{}
	for _, f := range st.Files {
		byPath[f.Path] = f
	}
	if f := byPath["renamed.txt"]; f.Orig != "old-name.txt" || f.mark() != "R" {
		t.Errorf("rename = %+v", f)
	}
	if f := byPath["conflict.txt"]; !f.Conflicted || f.mark() != "U" {
		t.Errorf("conflict = %+v", f)
	}
	if f := byPath["new file.txt"]; !f.Untracked || f.mark() != "?" || !f.unstaged() {
		t.Errorf("untracked = %+v", f)
	}
}

// TestParseGitStatusInitial reads an unborn branch.
func TestParseGitStatusInitial(t *testing.T) {
	st := parseGitStatus("# branch.oid (initial)\x00# branch.head main\x00")
	if !st.Initial || st.Branch != "main" || len(st.Files) != 0 {
		t.Fatalf("state = %+v", st)
	}
}

// TestParseGitLog reads the separated log records.
func TestParseGitLog(t *testing.T) {
	raw := "abc123\x1fabc\x1fAlice\x1falice@example.com\x1f2026-01-02T03:04:05+08:00\x1f修复一个错误\x1e\n" +
		"def456\x1fdef\x1fBob\x1fbob@example.com\x1f2026-01-03T04:05:06Z\x1fAdd a test\x1e"
	commits := parseGitLog(raw)
	if len(commits) != 2 {
		t.Fatalf("commits = %d, want 2", len(commits))
	}
	if commits[0].Subject != "修复一个错误" || commits[0].Author != "Alice" || commits[0].Short != "abc" {
		t.Fatalf("first = %+v", commits[0])
	}
	if !commits[1].Date.Equal(time.Date(2026, 1, 3, 4, 5, 6, 0, time.UTC)) {
		t.Fatalf("second date = %v", commits[1].Date)
	}
}

// TestSplitGitPath splits the folder from the name with forward slashes.
func TestSplitGitPath(t *testing.T) {
	name, dir := viewkit.SplitGitPath("src/app/main.go")
	if name != "main.go" || dir != "src/app" {
		t.Fatalf("split = (%q, %q)", name, dir)
	}
	name, dir = viewkit.SplitGitPath("note.txt")
	if name != "note.txt" || dir != "" {
		t.Fatalf("split = (%q, %q)", name, dir)
	}
}

// TestParseRemoteBranches checks the symbolic HEAD is left out.
func TestParseRemoteBranches(t *testing.T) {
	out := "origin/HEAD\norigin/main\norigin/feature/x\n"
	got := parseRemoteBranches(out)
	if len(got) != 2 || got[0] != "origin/main" || got[1] != "origin/feature/x" {
		t.Fatalf("branches = %v", got)
	}
}
