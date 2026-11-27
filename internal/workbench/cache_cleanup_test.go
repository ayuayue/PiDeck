//go:build !js && !android && !ios

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

func TestCacheCleanupAllPreservesFilesAndReportsFailures(t *testing.T) {
	for _, blocked := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "partial failure"}[blocked], func(t *testing.T) {
			dir := t.TempDir()
			st, err := newStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			a := &app{st: st}
			keep := []string{"sessions/owned.jsonl", "exports/backup.zip", "favorites.json", "tasks.json", "logs/events.jsonl", "logs/pideck.log.1"}
			for _, name := range append(keep, "session-meta-cache.json", "announcements-cache.json") {
				path := filepath.Join(dir, filepath.FromSlash(name))
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if blocked {
				path := filepath.Join(dir, "session-meta-cache.json")
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(path, "blocked"), []byte("keep"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			sessionHistory.Lock()
			sessionHistory.items["cache-cleanup-fixture"] = historyEntry{}
			sessionHistory.Unlock()
			for range 2 {
				err := a.clearCache("all")
				if (err != nil) != blocked {
					t.Fatalf("clear all error = %v, blocked = %v", err, blocked)
				}
			}
			sessionHistory.Lock()
			remaining := len(sessionHistory.items)
			sessionHistory.Unlock()
			if remaining != 0 {
				t.Fatalf("transcript cache retained %d entries", remaining)
			}
			if _, err := os.Stat(filepath.Join(dir, "announcements-cache.json")); !os.IsNotExist(err) {
				t.Fatalf("announcement cleanup did not run: %v", err)
			}
			for _, name := range keep {
				data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
				if err != nil || string(data) != "keep" {
					t.Fatalf("user file %s changed: %q, %v", name, data, err)
				}
			}
		})
	}
}
