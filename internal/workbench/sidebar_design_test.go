//go:build !js && !android && !ios

package workbench

import (
	"path/filepath"
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestSessionFileEntriesStayInProject(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "nested", "absolute.go")
	outside := filepath.Join(filepath.Dir(root), "outside.go")
	changes := []fileChange{
		{Path: "internal/relative.go", Added: 2},
		{Path: inside, Removed: 3},
		{Path: "../outside.go"},
		{Path: outside},
		{Path: root},
		{Path: ""},
	}
	got := sessionFileEntries(root, changes)
	if len(got) != 2 {
		t.Fatalf("session entries = %+v, want only the two project files", got)
	}
	if got[0].Rel != "internal/relative.go" || got[0].Change != changes[0] {
		t.Fatalf("relative change = %+v", got[0])
	}
	if got[1].Rel != "nested/absolute.go" || got[1].Change != changes[1] {
		t.Fatalf("absolute change must retain its original patch lookup path: %+v", got[1])
	}
}

func TestGitSidebarKeepsDraftAndSeparatesConflicts(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless interaction regression")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	root := t.TempDir()
	state := gitState{IsRepo: true, Checked: true, Root: root, Branch: "main",
		Files: []gitFile{{Path: "staged.go", X: 'M', Y: ' '}}}
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		a.git.state.Set(state)
		return a.drawerGit()
	}, nsgotest.Size(340, 800))
	screen.Type("id:git-commit-message", "sidebar draft")
	inputID := screen.Find("id:git-commit-message").ID
	state.Ahead = 1
	screen.Post(func() { a.git.state.Set(state) })
	screen.Settle()
	if field := screen.Find("id:git-commit-message"); field.ID != inputID || field.Text != "sidebar draft" {
		t.Fatalf("status update replaced the draft input: %+v", field)
	}
	if !screen.Enabled("id:git-commit") {
		t.Fatal("a staged file with a message should be committable")
	}
	screen.Press("id:git-tab-history")
	screen.Type("id:git-log-search", "history query")
	screen.Press("id:git-tab-changes")
	if got := screen.Find("id:git-commit-message").Text; got != "sidebar draft" {
		t.Fatalf("tab navigation lost the commit draft: %q", got)
	}
	screen.Press("id:git-tab-history")
	if got := screen.Find("id:git-log-search").Text; got != "history query" {
		t.Fatalf("tab navigation lost the history query: %q", got)
	}
	screen.Press("id:git-tab-changes")

	state.Files = append(state.Files, gitFile{Path: "conflict.go", X: 'U', Y: 'U', Conflicted: true})
	screen.Post(func() { a.git.state.Set(state) })
	screen.Settle()
	if !screen.Exists("id:git-conflicts") || screen.Exists("id:git-file") {
		t.Fatal("a conflicted file must appear only in the conflict group")
	}
	for _, id := range []string{"git-commit", "git-commit-all", "git-commit-push"} {
		if screen.Enabled("id:" + id) {
			t.Fatalf("%s must be disabled until conflicts are resolved", id)
		}
	}
}
