//go:build !js && !android && !ios

package workbench

// Checks for the favorites filter and the on-disk list.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestFilterFavorites checks the kind filter and the search query.
func TestFilterFavorites(t *testing.T) {
	now := time.Now()
	list := []favoriteEntry{
		{ID: "1", Kind: favoriteReply, SessionTitle: "重构登录", Text: "先补测试再改结构", CreatedAt: now},
		{ID: "2", Kind: favoriteSession, SessionID: "s2", SessionTitle: "发布检查", CreatedAt: now},
		{ID: "3", Kind: favoriteReply, SessionTitle: "文档", Text: "把步骤写短一点", Project: "/tmp/docs", CreatedAt: now},
	}
	if got := len(filterFavorites(list, "", "")); got != 3 {
		t.Errorf("all = %d", got)
	}
	if got := len(filterFavorites(list, favoriteReply, "")); got != 2 {
		t.Errorf("replies = %d", got)
	}
	if got := len(filterFavorites(list, favoriteSession, "")); got != 1 {
		t.Errorf("sessions = %d", got)
	}
	if got := filterFavorites(list, "", "登录"); len(got) != 1 || got[0].ID != "1" {
		t.Errorf("query by title = %+v", got)
	}
	if got := filterFavorites(list, "", "步骤"); len(got) != 1 || got[0].ID != "3" {
		t.Errorf("query by text = %+v", got)
	}
	if got := filterFavorites(list, "", "tmp/docs"); len(got) != 1 || got[0].ID != "3" {
		t.Errorf("query by project = %+v", got)
	}
}

// TestLoadFavorites keeps the two kinds and drops entries that lost their
// meaning.
func TestLoadFavorites(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	file := favoritesFile{Version: 1, Entries: []favoriteEntry{
		{ID: "reply", Kind: favoriteReply, Text: "answer"},
		{ID: "empty", Kind: favoriteReply},
		{ID: "session", Kind: favoriteSession, SessionID: "s1"},
		{ID: "nosession", Kind: favoriteSession},
		{ID: "bogus", Kind: "other", Text: "x"},
	}}
	raw, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "favorites.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	kept := a.loadFavorites()
	if len(kept) != 2 || kept[0].ID != "reply" || kept[1].ID != "session" {
		t.Fatalf("kept = %+v", kept)
	}
	if kept[0].CreatedAt.IsZero() {
		t.Error("a loaded entry has no timestamp")
	}
}
