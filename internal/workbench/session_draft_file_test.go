package workbench

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestDraftShutdownFlushesLatestRemoteText(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("write", func(t *testing.T) {
		var s *session
		screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
			a := &app{cx: cx, st: st, byID: map[string]*session{}}
			s = a.makeSession(sessionMeta{ID: "draft-fixture", Cwd: "/home/test/work", Title: "Remote draft"}, target{Kind: targetWSL, Distro: "Debian"})
			return core.Text{ContentFunc: s.draft.Get}
		})
		s.draft.Set("最后输入的草稿")
		screen.Settle()
		// Deliberately do not advance the debounce clock. Scope shutdown
		// must flush the draft before the caller joins outstanding writes.
	})
	sessionDraftWrites.Wait()
	drafts := readSessionDrafts(dir)
	if got := drafts["draft-fixture"]; got.Text != "最后输入的草稿" || got.Target != (target{Kind: targetWSL, Distro: "Debian"}).key() {
		t.Fatalf("draft after shutdown = %+v", got)
	}
	if err := st.saveSessionDraft(storedSessionDraft{ID: "draft-fixture", Text: "old"}, 0); err != nil {
		t.Fatal(err)
	}
	if got := readSessionDrafts(dir)["draft-fixture"].Text; got != "最后输入的草稿" {
		t.Fatalf("stale write replaced current text: %q", got)
	}
	if err := st.saveSessionDraft(storedSessionDraft{ID: "draft-fixture"}, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, sessionDraftDir, sessionDraftName("draft-fixture"))); !os.IsNotExist(err) {
		t.Fatalf("draft removal: %v", err)
	}
}
