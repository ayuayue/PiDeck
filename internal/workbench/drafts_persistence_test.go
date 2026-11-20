//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func draftLibraryFixtureJSON(t *testing.T, items []savedDraft) []byte {
	t.Helper()
	raw, err := json.MarshalIndent(struct {
		Version int          `json:"version"`
		Drafts  []savedDraft `json:"drafts"`
	}{Version: 1, Drafts: items}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func startDraftLibraryFixture(t *testing.T, items []savedDraft) (*app, *nsgotest.App, []byte) {
	t.Helper()
	if nsgotest.Target() != "" {
		t.Skip("headless persistence regression")
	}
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", dir)
	raw := draftLibraryFixtureJSON(t, items)
	if len(raw) > draftFileLimit {
		t.Fatal("initial draft fixture exceeds the reader limit")
	}
	if err := os.WriteFile(filepath.Join(dir, draftsFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = &app{cx: cx, st: &store{dir: dir}, drafts: newDraftLibrary(cx), toaster: ui.NewToaster(cx)}
		a.drafts.items.Set(slices.Clone(items))
		return ui.Toasts{Toaster: a.toaster}
	})
	return a, screen, raw
}

func draftLibraryFixtureEntries(count int, text string) []savedDraft {
	items := make([]savedDraft, count)
	for i := range items {
		items[i] = savedDraft{ID: fmt.Sprintf("draft-%03d", i), Title: fmt.Sprintf("Template %d", i), Text: text}
	}
	return items
}

func TestDraftLibrarySerializedSizeLimit(t *testing.T) {
	for _, tc := range []struct {
		name   string
		count  int
		reject bool
	}{{"below_limit", 42, false}, {"above_limit", 43, true}} {
		t.Run(tc.name, func(t *testing.T) {
			// HTML escaping expands each '<' to six JSON bytes. Every draft
			// remains valid and the list is well below its 128-entry limit.
			items := draftLibraryFixtureEntries(tc.count, strings.Repeat("<", draftBodyLimit))
			for _, d := range items {
				if !d.valid() {
					t.Fatal("serialized-size fixture contains an invalid draft")
				}
			}
			encoded := draftLibraryFixtureJSON(t, items)
			if (len(encoded) > draftFileLimit) != tc.reject {
				t.Fatalf("fixture encodes to %d bytes, limit %d, reject %v", len(encoded), draftFileLimit, tc.reject)
			}
			before := items[1:]
			a, screen, saved := startDraftLibraryFixture(t, before)
			a.drafts.edit.Set(items[0])
			a.saveDraftEntry()
			screen.WaitUntil(5*time.Second, func() bool { return !a.drafts.busy.GetUntracked() })
			raw, err := os.ReadFile(filepath.Join(a.st.dir, draftsFile))
			if err != nil {
				t.Fatal(err)
			}
			if tc.reject {
				if !bytes.Equal(raw, saved) {
					t.Errorf("oversized save replaced the library: got %d bytes, want the original %d bytes", len(raw), len(saved))
				}
				if !slices.Equal(a.drafts.items.GetUntracked(), before) || !slices.Equal(readDraftLibrary(a.st.dir), before) {
					t.Error("oversized save changed the visible or reloaded library")
				}
				if a.drafts.edit.GetUntracked() != items[0] {
					t.Error("oversized save cleared the edited draft")
				}
				screen.WaitFor("text:草稿本已满", 5*time.Second)
				retry := slices.Clone(items)
				retry[0].Text = "shortened draft"
				a.drafts.edit.Set(retry[0])
				a.saveDraftEntry()
				screen.WaitUntil(5*time.Second, func() bool { return !a.drafts.busy.GetUntracked() })
				if !slices.Equal(readDraftLibrary(a.st.dir), retry) || a.drafts.edit.GetUntracked().ID != "" {
					t.Fatal("shortening the rejected draft did not allow a complete save")
				}
				return
			}
			if len(raw) > draftFileLimit || !slices.Equal(readDraftLibrary(a.st.dir), items) || !slices.Equal(a.drafts.items.GetUntracked(), items) {
				t.Errorf("valid save did not round-trip %d drafts within %d bytes", len(items), draftFileLimit)
			}
			if a.drafts.edit.GetUntracked().ID != "" {
				t.Error("successful save left the draft editor open")
			}
		})
	}
}

func TestDraftLibraryCountLimitPreservesState(t *testing.T) {
	items := draftLibraryFixtureEntries(draftCountLimit+1, "saved text")
	before := items[1:]
	a, screen, saved := startDraftLibraryFixture(t, before)
	a.drafts.edit.Set(items[0])
	a.saveDraftEntry()
	screen.WaitFor("text:草稿本已满", 5*time.Second)
	raw, err := os.ReadFile(filepath.Join(a.st.dir, draftsFile))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, saved) || !slices.Equal(a.drafts.items.GetUntracked(), before) || a.drafts.edit.GetUntracked() != items[0] {
		t.Fatal("entry-count rejection changed the file, list or edited draft")
	}
	if a.drafts.busy.GetUntracked() {
		t.Fatal("entry-count rejection left saving blocked")
	}
}

func TestDraftLibraryWriteFailureCanRetry(t *testing.T) {
	items := draftLibraryFixtureEntries(2, "saved text")
	a, screen, saved := startDraftLibraryFixture(t, items[1:])
	path := filepath.Join(a.st.dir, draftsFile)
	if err := os.Rename(path, path+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	a.drafts.edit.Set(items[0])
	a.saveDraftEntry()
	screen.WaitUntil(5*time.Second, func() bool { return !a.drafts.busy.GetUntracked() })
	screen.WaitFor("text:保存失败", 5*time.Second)
	if !slices.Equal(a.drafts.items.GetUntracked(), items[1:]) || a.drafts.edit.GetUntracked() != items[0] {
		t.Fatal("failed write changed the list or cleared the edited draft")
	}
	raw, err := os.ReadFile(path + ".saved")
	if err != nil || !bytes.Equal(raw, saved) {
		t.Fatalf("failed write changed the original file: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path+".saved", path); err != nil {
		t.Fatal(err)
	}
	a.saveDraftEntry()
	screen.WaitUntil(5*time.Second, func() bool { return !a.drafts.busy.GetUntracked() })
	if !slices.Equal(readDraftLibrary(a.st.dir), items) || a.drafts.edit.GetUntracked().ID != "" {
		t.Fatal("retry did not save all drafts and close the editor")
	}
	if temps, err := filepath.Glob(filepath.Join(a.st.dir, ".*tmp*")); err != nil || len(temps) != 0 {
		t.Fatalf("draft save left temporary files: %v, %v", temps, err)
	}
}
