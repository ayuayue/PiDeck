//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

// Exercise the real favorites page without starting pi or scanning user data.
func startFavoriteFixture(t *testing.T) (*app, *nsgotest.App) {
	t.Helper()
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	seed := []favoriteEntry{
		{ID: "saved-session", Kind: favoriteSession, SessionID: "s1", SessionTitle: "saved conversation", CreatedAt: time.Unix(100, 0).UTC()},
		{ID: "saved-reply", Kind: favoriteReply, SessionID: "s2", Text: "saved answer", CreatedAt: time.Unix(200, 0).UTC()},
	}
	raw, err := json.Marshal(favoritesFile{Version: 1, Entries: seed})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "favorites.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = &app{
			cx: cx, st: &store{dir: home}, favorites: seed,
			favKind: core.NewSignal(cx, ""), favQuery: core.NewSignal(cx, ""), favRev: core.NewSignal(cx, 0),
			langRev: core.NewSignal(cx, 0), toaster: ui.NewToaster(cx),
			confirmOpen: core.NewSignal(cx, false), confirmHead: core.NewSignal(cx, ""),
			confirmBody: core.NewSignal(cx, ""), confirmWhy: core.NewSignal(cx, ""),
		}
		return core.View{Style: ui.FillRest, Children: []core.Node{
			a.favoritesPane(), a.confirmDialog(), ui.Toasts{Toaster: a.toaster},
		}}
	}, nsgotest.Size(1100, 750))
	t.Cleanup(favoriteWrites.Wait)
	return a, screen
}

// A directory at the file's destination makes the actual atomic rename fail
// on every desktop platform, without depending on permissions or a mock writer.
func blockFavoriteWrites(t *testing.T, a *app) func() {
	t.Helper()
	path := a.favoritesPath()
	if err := os.Rename(path, path+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	return func() {
		t.Helper()
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(path+".saved", path); err != nil {
			t.Fatal(err)
		}
	}
}

func expectFavoriteSaveFailure(t *testing.T, a *app, screen *nsgotest.App, before []favoriteEntry, success string) {
	t.Helper()
	screen.WaitUntil(5*time.Second, func() bool {
		return len(screen.Query("text:保存失败"))+len(screen.Query("text:收藏失败"))+len(screen.Query("text:"+success)) > 0
	})
	if len(screen.Query("text:"+success)) > 0 {
		t.Errorf("failed favorite write displayed success %q", success)
	}
	if len(screen.Query("text:保存失败"))+len(screen.Query("text:收藏失败")) == 0 {
		t.Error("failed favorite write did not display an error")
	}
	if got := a.favoriteList(); !reflect.DeepEqual(got, before) {
		t.Fatalf("failed favorite write changed the list: got %+v, want %+v", got, before)
	}
	if a.favRev.GetUntracked() != 0 {
		t.Fatal("failed favorite write published a changed revision")
	}
}

func TestFavoriteAddFailureDoesNotReportSuccess(t *testing.T) {
	a, screen := startFavoriteFixture(t)
	before := a.favoriteList()
	restore := blockFavoriteWrites(t, a)
	s := &session{ID: "new-session", title: core.NewSignal(a.cx, "new conversation")}
	a.favoriteSession(s)
	expectFavoriteSaveFailure(t, a, screen, before, "已收藏会话")
	restore()
	a.favoriteSession(s)
	screen.WaitFor("text:已收藏会话", 5*time.Second)
	if got := a.loadFavorites(); len(got) != 3 || got[0].SessionID != s.ID {
		t.Fatalf("retry did not persist the new favorite: %+v", got)
	}
}

func TestFavoriteRemoveFailureKeepsSavedEntries(t *testing.T) {
	a, screen := startFavoriteFixture(t)
	before := a.favoriteList()
	restore := blockFavoriteWrites(t, a)
	screen.Press("id:favorite-delete-saved-session")
	expectFavoriteSaveFailure(t, a, screen, before, "已取消收藏")
	screen.WaitFor("id:favorite-saved-session", 5*time.Second)
	restore()
	screen.Press("id:favorite-delete-saved-session")
	screen.WaitFor("text:已取消收藏", 5*time.Second)
	if got := a.loadFavorites(); len(got) != 1 || got[0].ID != "saved-reply" {
		t.Fatalf("retry did not persist the removal: %+v", got)
	}
}

func TestFavoriteClearFailureKeepsSavedEntries(t *testing.T) {
	a, screen := startFavoriteFixture(t)
	before := a.favoriteList()
	restore := blockFavoriteWrites(t, a)
	screen.Press("id:favorite-clear")
	screen.Press("id:confirm-ok")
	expectFavoriteSaveFailure(t, a, screen, before, "已清空收藏")
	restore()
	screen.Press("id:favorite-clear")
	screen.Press("id:confirm-ok")
	screen.WaitFor("text:已清空收藏", 5*time.Second)
	if got := a.loadFavorites(); len(got) != 0 {
		t.Fatalf("retry did not persist the empty list: %+v", got)
	}
}

func TestFavoriteToggleFailureKeepsSavedEntries(t *testing.T) {
	a, screen := startFavoriteFixture(t)
	before := a.favoriteList()
	restore := blockFavoriteWrites(t, a)
	s := &session{ID: "s1", title: core.NewSignal(a.cx, "saved conversation")}
	a.toggleSessionFavorite(s)
	expectFavoriteSaveFailure(t, a, screen, before, "已移出收藏夹")
	restore()
	a.toggleSessionFavorite(s)
	screen.WaitFor("text:已移出收藏夹", 5*time.Second)
	if got := a.loadFavorites(); len(got) != 1 || got[0].ID != "saved-reply" {
		t.Fatalf("retry did not persist the toggle: %+v", got)
	}
}

func TestFavoriteWritesKeepRequestOrder(t *testing.T) {
	a, screen := startFavoriteFixture(t)
	first := &session{ID: "queued-first", title: core.NewSignal(a.cx, "first conversation")}
	last := &session{ID: "queued-last", title: core.NewSignal(a.cx, "last conversation")}
	a.favoriteSession(first)
	a.favoriteSession(first) // A duplicate must see the preceding durable change.
	a.favoriteReply(first, turn{Final: "queued answer"})
	a.removeFavorite("saved-session")
	a.clearFavorites()
	a.favoriteSession(last)
	if a.favRev.GetUntracked() != 0 || a.favoriteCount() != 2 {
		t.Fatal("queued changes published before their save completed on the UI graph")
	}
	screen.WaitUntil(5*time.Second, func() bool { return a.favWriteTail == nil })
	got := a.favoriteList()
	if len(got) != 1 || got[0].SessionID != last.ID {
		t.Fatalf("queued changes finished out of order: %+v", got)
	}
	if a.favRev.GetUntracked() != 5 {
		t.Fatalf("published %d revisions, want five changes and one duplicate", a.favRev.GetUntracked())
	}
	if saved := a.loadFavorites(); !reflect.DeepEqual(saved, got) {
		t.Fatalf("durable favorites = %+v, want published %+v", saved, got)
	}
}

func TestFavoriteDuplicateRequestsSaveOnce(t *testing.T) {
	a, screen := startFavoriteFixture(t)
	s := &session{ID: "queued-session", title: core.NewSignal(a.cx, "queued conversation")}
	for range 3 {
		a.favoriteSession(s)
	}
	for range 2 {
		a.favoriteReply(s, turn{Prompt: "question", Final: "answer"})
	}
	screen.WaitUntil(5*time.Second, func() bool { return a.favWriteTail == nil })
	if got := a.loadFavorites(); len(got) != 4 || got[0].Kind != favoriteReply || got[1].Kind != favoriteSession {
		t.Fatalf("duplicate requests created extra favorites: %+v", got)
	}
	if a.favRev.GetUntracked() != 2 {
		t.Fatalf("duplicate requests published %d changes, want 2", a.favRev.GetUntracked())
	}
	screen.WaitFor("text:已经收藏过这条回复", 5*time.Second)
}

func TestFavoriteFailedChangesDoNotLeakIntoNextSave(t *testing.T) {
	a, screen := startFavoriteFixture(t)
	before := a.favoriteList()
	restore := blockFavoriteWrites(t, a)
	failed := &session{ID: "failed-session", title: core.NewSignal(a.cx, "failed conversation")}
	a.favoriteSession(failed)
	a.removeFavorite("saved-session")
	a.clearFavorites()
	screen.WaitUntil(5*time.Second, func() bool { return a.favWriteTail == nil })
	expectFavoriteSaveFailure(t, a, screen, before, "已清空收藏")
	restore()
	next := &session{ID: "next-session", title: core.NewSignal(a.cx, "next conversation")}
	a.favoriteSession(next)
	screen.WaitUntil(5*time.Second, func() bool { return a.favWriteTail == nil })
	got := a.loadFavorites()
	if len(got) != 3 || got[0].SessionID != next.ID || !reflect.DeepEqual(got[1:], before) {
		t.Fatalf("a later save included a failed change: %+v", got)
	}
}

func TestFavoriteShutdownFlushesPendingWrites(t *testing.T) {
	a, screen := startFavoriteFixture(t)
	first := &session{ID: "before-exit", title: core.NewSignal(a.cx, "before exit")}
	last := &session{ID: "last-before-exit", title: core.NewSignal(a.cx, "last before exit")}
	a.favoriteSession(first)
	a.clearFavorites()
	a.favoriteSession(last)
	finished := make(chan struct{})
	go func() {
		Shutdown()
		close(finished)
	}()
	// Do not settle the graph while exiting: pending disk writes must finish
	// even when the window can no longer process publication callbacks.
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not finish the queued favorite writes without the UI")
	}
	if got := a.loadFavorites(); len(got) != 1 || got[0].SessionID != last.ID {
		t.Fatalf("shutdown lost or reordered pending favorites: %+v", got)
	}
	screen.Settle()
}
