//go:build !js && !android && !ios

package workbench

// Checks the history: one file's commits, and the drawer's count.

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestGitFileHistory(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, run := gitFixture(t)
	if err := os.WriteFile(filepath.Join(dir, "other.txt"), []byte("other\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "other file")
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("third\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("commit", "-am", "third")
	// One uncommitted change, so the file has a row to open.
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	app := startGitApp(t, dir)
	waitApp(app, "id:git-file >> nth=0", 20*time.Second)
	app.Press("id:git-file >> nth=0")
	app.WaitFor("id:git-diff", 10*time.Second)
	app.Press("id:git-file-history")
	app.WaitFor("id:git-file-history-dialog", 10*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:git-history-row")) == 3 })
	app.Press("id:git-history-row >> nth=0")
	app.WaitFor("id:git-diff", 10*time.Second)
}

// TestGitHistoryCountsAllCommits protects the heading's number: it counts
// every commit HEAD reaches, while the list reads one page at a time.
func TestGitHistoryCountsAllCommits(t *testing.T) {
	dir, run := gitFixture(t)
	const want = 55
	for i := 2; i < want; i++ {
		run("commit", "--allow-empty", "-m", fmt.Sprintf("empty %d", i))
	}
	st := readGitState(localTarget, dir, 50)
	if len(st.Commits) != 50 || st.Total != want || st.historyCount() != want {
		t.Fatalf("history = %d loaded, %d total, %d shown; want 50 loaded of %d",
			len(st.Commits), st.Total, st.historyCount(), want)
	}
	// Asking for more keeps the same total.
	st = readGitState(localTarget, dir, 100)
	if len(st.Commits) != want || st.historyCount() != want {
		t.Fatalf("history after more = %d loaded, %d shown; want %d", len(st.Commits), st.historyCount(), want)
	}
}

// TestGitHistorySearchFindsWholeHistory protects the query box against the
// page limit: a commit older than the loaded page is found by its message,
// its author and its hash.
func TestGitHistorySearchFindsWholeHistory(t *testing.T) {
	dir, run := gitFixture(t)
	run("commit", "--allow-empty", "--author", "老作者 <old@example.com>", "-m", "很早的一条提交")
	old := strings.TrimSpace(run("rev-parse", "HEAD"))
	const empties = 55
	for i := 0; i < empties; i++ {
		run("commit", "--allow-empty", "-m", fmt.Sprintf("empty %d", i))
	}
	st := readGitState(localTarget, dir, 50)
	if len(st.Commits) != 50 || st.Total != empties+3 {
		t.Fatalf("page = %d of %d commits, want 50 of %d", len(st.Commits), st.Total, empties+3)
	}
	if slices.ContainsFunc(st.Commits, func(c gitCommit) bool { return c.Hash == old }) {
		t.Fatal("the old commit should be past the page the drawer read")
	}
	for _, query := range []string{"很早的一条提交", "老作者", old[:7]} {
		hits, err := searchCommits(localTarget, dir, query, 100)
		if err != nil {
			t.Fatalf("search %q: %v", query, err)
		}
		if len(hits) != 1 || hits[0].Hash != old {
			t.Fatalf("search %q = %+v, want only %s", query, hits, old)
		}
	}
	if hits, err := searchCommits(localTarget, dir, "这里没有这个词", 100); err != nil || len(hits) != 0 {
		t.Fatalf("unmatched query = %d hits, %v; want none", len(hits), err)
	}
	// The limit applies to the merged answer, not to each field.
	if hits, err := searchCommits(localTarget, dir, "empty", 10); err != nil || len(hits) != 10 {
		t.Fatalf("limited search = %d hits, %v; want 10", len(hits), err)
	}
}

// TestGitHistorySearchBox reads a commit through the drawer's box by words
// only its body carries, which the page filter cannot see.
func TestGitHistorySearchBox(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, run := gitFixture(t)
	run("commit", "--allow-empty", "-m", "普通标题", "-m", "深层说明")
	app := startGitApp(t, dir)
	waitApp(app, "id:git-commit-row", 20*time.Second)
	app.Type("id:git-log-search", "深层说明")
	app.Advance(searchDebounce)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:git-commit-row")) == 1 })
	app.Clear("id:git-log-search")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:git-commit-row")) == 3 })
}

// TestGitHistoryLoadsPastFiveHundred protects the removed cap: pressing
// "加载更多提交" must keep reaching further back.
func TestGitHistoryLoadsPastFiveHundred(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, _ := gitFixture(t)
	var repo *gitRepo
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		repo = newGitRepo(cx)
		return core.View{}
	}, nsgotest.Size(600, 400))
	repo.attach(&workspace{Path: dir, Target: localTarget})
	screen.WaitUntil(20*time.Second, func() bool { return !repo.working })
	repo.logLimit = 500
	repo.loadMore()
	if repo.logLimit != 550 {
		t.Fatalf("history limit = %d, want 550", repo.logLimit)
	}
	screen.WaitUntil(20*time.Second, func() bool { return !repo.working })
	if got := repo.state.GetUntracked().LogLimit; got != 550 {
		t.Fatalf("published limit = %d, want 550", got)
	}
}
