//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// A status-only poll must keep the data used by menus and history pagination.
func TestGitPollPreservesPanelMetadata(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, run := gitFixture(t)
	run("branch", "--no-track", "feature")
	run("tag", "v1.0.0")
	var repo *gitRepo
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		repo = newGitRepo(cx)
		return core.View{}
	}, nsgotest.Size(600, 400))
	repo.attach(&workspace{Path: dir, Target: localTarget})
	screen.WaitUntil(20*time.Second, func() bool { return !repo.working })
	before := repo.state.GetUntracked()
	if !before.IsRepo || before.Error != "" || before.Root == "" || len(before.Commits) != 2 || before.LogLimit != 50 ||
		!slices.Contains(before.Branches, "feature") || !slices.Contains(before.RemoteBranches, "origin/main") ||
		!slices.Equal(before.Tags, []string{"v1.0.0"}) || len(before.Remotes) != 1 || before.Remotes[0].Name != "origin" {
		t.Fatalf("full refresh did not load the fixture: %+v", before)
	}

	// Change branch outside the panel: a poll must publish its new status while
	// keeping metadata that only a full refresh reads.
	run("checkout", "feature")
	for _, step := range []struct {
		name, content string
		changes       int
	}{
		{"dirty", "changed\n", 1},
		{"clean", "second\n", 0},
	} {
		if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte(step.content), 0o644); err != nil {
			t.Fatal(err)
		}
		repo.poll()
		screen.WaitUntil(10*time.Second, func() bool { return !repo.working })
		got := repo.state.GetUntracked()
		if !got.Checked || got.Loading || !got.IsRepo || got.Error != "" || got.Branch != "feature" ||
			got.Upstream != "" || got.Ahead != 0 || len(got.Files) != step.changes {
			t.Fatalf("%s: poll did not publish fresh status: %+v", step.name, got)
		}
		if step.changes > 0 && (got.Files[0].Path != "note.txt" || !got.Files[0].unstaged()) {
			t.Errorf("%s: changed file = %+v, want unstaged note.txt", step.name, got.Files[0])
		}
		if got.Root != before.Root || !reflect.DeepEqual(got.Commits, before.Commits) || !slices.Equal(got.Branches, before.Branches) {
			t.Errorf("%s: poll lost root, history or local branches: %+v", step.name, got)
		}
		if !slices.Equal(got.RemoteBranches, before.RemoteBranches) {
			t.Errorf("%s: remote branches = %v, want %v", step.name, got.RemoteBranches, before.RemoteBranches)
		}
		if !slices.Equal(got.Tags, before.Tags) {
			t.Errorf("%s: tags = %v, want %v", step.name, got.Tags, before.Tags)
		}
		if !slices.Equal(got.Remotes, before.Remotes) {
			t.Errorf("%s: remotes = %v, want %v", step.name, got.Remotes, before.Remotes)
		}
		if got.LogLimit != before.LogLimit {
			t.Errorf("%s: history limit = %d, want %d", step.name, got.LogLimit, before.LogLimit)
		}
	}

	// Once the directory stops being a repository, stale metadata must go away.
	if err := os.Rename(filepath.Join(dir, ".git"), filepath.Join(t.TempDir(), "metadata")); err != nil {
		t.Fatal(err)
	}
	repo.poll()
	screen.WaitUntil(10*time.Second, func() bool { return !repo.working })
	if got := repo.state.GetUntracked(); !reflect.DeepEqual(got, gitState{Checked: true, NotRepo: true}) {
		t.Fatalf("non-repository poll retained repository state: %+v", got)
	}
}
