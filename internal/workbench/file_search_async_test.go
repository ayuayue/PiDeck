//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// Keep the search on its own graph, without pi, startup scans or user settings.
func startFileSearchFixture(t *testing.T, root string) (*app, *nsgotest.App) {
	t.Helper()
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = &app{
			cx:              cx,
			activeID:        core.NewSignal(cx, ""),
			activePane:      core.NewSignal(cx, ""),
			workspaces:      core.NewSignalFunc(cx, []*workspace(nil), nil),
			files:           newFileTree(cx),
			filesRev:        core.NewSignal(cx, 0),
			editor:          newEditorHost(cx),
			langRev:         core.NewSignal(cx, 0),
			chatWidthPctSig: core.NewSignal(cx, chatWidthPctDefault),
			fileSearchOpen:  core.NewSignal(cx, true),
			fileSearchQuery: core.NewSignal(cx, ""),
			fileSearchBusy:  core.NewSignal(cx, false),
			fileSearchRev:   core.NewSignal(cx, 0),
		}
		a.files.root.Set(root)
		return a.fileSearchDialog()
	}, nsgotest.Size(1000, 750))
	return a, screen
}

func TestFileSearchDropsResultAfterWorkspaceSwitch(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	for _, dir := range []string{first, second} {
		if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("needle in "+filepath.Base(dir)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	a, screen := startFileSearchFixture(t, first)
	a.fileSearchQuery.Set("needle")
	a.runFileSearch()
	// Do not settle until after the switch: even a fast disk read must publish
	// through the graph's queue, making this ordering deterministic.
	a.files.root.Set(second)
	screen.WaitUntil(10*time.Second, func() bool { return !a.fileSearchBusy.GetUntracked() })
	if hits := a.fileSearchResults(); len(hits) != 0 {
		t.Fatalf("previous workspace published hits in the new workspace: %+v", hits)
	}
	if hits := screen.Query("id:file-search-hit"); len(hits) != 0 {
		t.Fatalf("previous workspace left %d visible results", len(hits))
	}

	a.runFileSearch()
	screen.WaitUntil(10*time.Second, func() bool { return !a.fileSearchBusy.GetUntracked() })
	hits := a.fileSearchResults()
	if len(hits) != 1 || !strings.Contains(hits[0].Text, filepath.Base(second)) {
		t.Fatalf("new workspace search = %+v, want its own note.txt", hits)
	}
}

func TestFileSearchResultsStayInTheirWorkspace(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	for dir, body := range map[string]string{first: "first project needle", second: "second project target"} {
		if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	a, screen := startFileSearchFixture(t, first)
	a.fileSearchQuery.Set("needle")
	a.runFileSearch()
	screen.WaitFor("id:file-search-hit", 10*time.Second)
	screen.Press("id:file-search-close")
	a.openFileSearch()
	screen.WaitFor("id:file-search-hit", 5*time.Second)

	a.files.root.Set(second)
	screen.Settle()
	if hits := screen.Query("id:file-search-hit"); len(hits) != 0 {
		t.Fatalf("switching projects retained %d results for a different note.txt", len(hits))
	}
	screen.Press("id:file-search-close")
	a.openFileSearch()
	screen.Settle()
	if hits := screen.Query("id:file-search-hit"); len(hits) != 0 {
		t.Fatalf("reopening search retained %d results from the old project", len(hits))
	}

	a.fileSearchQuery.Set("target")
	a.runFileSearch()
	screen.WaitFor("id:file-search-hit", 10*time.Second)
	screen.Press("id:file-search-hit")
	screen.WaitUntil(10*time.Second, func() bool {
		f := a.editor.activeFile()
		return f != nil && !f.Loading.GetUntracked()
	})
	f := a.editor.activeFile()
	if f.Path != filepath.Join(second, "note.txt") || f.Text.GetUntracked() != "second project target" {
		t.Fatalf("opened %q with %q, want the second project's file", f.Path, f.Text.GetUntracked())
	}
}

func TestFileSearchClearsHitsWhileNewQueryRuns(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("alpha\nbeta"), 0o644); err != nil {
		t.Fatal(err)
	}
	a, screen := startFileSearchFixture(t, dir)
	a.fileSearchQuery.Set("alpha")
	a.runFileSearch()
	screen.WaitFor("id:file-search-hit", 10*time.Second)

	a.fileSearchQuery.Set("beta")
	a.runFileSearch()
	if !a.fileSearchBusy.GetUntracked() || len(a.fileSearchResults()) != 0 {
		t.Fatal("a new search retained selectable results from the previous query")
	}
	screen.WaitUntil(10*time.Second, func() bool { return !a.fileSearchBusy.GetUntracked() })
	hits := a.fileSearchResults()
	if len(hits) != 1 || hits[0].Line != 2 || hits[0].Text != "beta" {
		t.Fatalf("new query hits = %+v, want beta on line 2", hits)
	}
	a.fileSearchQuery.Set(" ")
	a.runFileSearch()
	if a.fileSearchBusy.GetUntracked() || len(a.fileSearchResults()) != 0 {
		t.Fatal("an empty query did not clear results and stop the busy state")
	}
}
