package workbench

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCacheCleanupPreservesUserData(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	for _, name := range []string{"session-meta-cache.json", "announcements-cache.json", "logs/pideck.log.1", "logs/pideck.log", "crashes/last.log", "sessions/owned.jsonl", "prompts/custom.json"} {
		file := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("keep"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, kind := range []string{"metadata", "transcripts", "announcements", "logs"} {
		if err := a.clearCache(kind); err != nil {
			t.Fatal(err)
		}
		if err := a.clearCache(kind); err != nil {
			t.Fatalf("repeat %s: %v", kind, err)
		}
	}
	if err := a.clearCache("../sessions"); err == nil {
		t.Fatal("accepted unknown cache category")
	}
	for _, name := range []string{"logs/pideck.log", "crashes/last.log", "sessions/owned.jsonl", "prompts/custom.json"} {
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil || string(data) != "keep" {
			t.Fatalf("user data %s changed: %q, %v", name, data, err)
		}
	}
	for _, name := range []string{"session-meta-cache.json", "announcements-cache.json", "logs/pideck.log.1"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(name))); !os.IsNotExist(err) {
			t.Fatalf("cache %s retained: %v", name, err)
		}
	}
}
