//go:build !js && !android && !ios

package workbench

// The phone's search keeps each session's text between calls, bounded by
// bytes: a library of long sessions must not become the desktop's heap.

import (
	"os"
	"strings"
	"testing"
	"time"
)

// fakeInfo is a file's identity without a file on disk.
type fakeInfo struct {
	name string
	size int64
	mod  time.Time
}

func (i fakeInfo) Name() string       { return i.name }
func (i fakeInfo) Size() int64        { return i.size }
func (i fakeInfo) Mode() os.FileMode  { return 0o644 }
func (i fakeInfo) ModTime() time.Time { return i.mod }
func (i fakeInfo) IsDir() bool        { return false }
func (i fakeInfo) Sys() any           { return nil }

func TestSearchCacheStaysWithinBudget(t *testing.T) {
	cache := &searchCache{entries: map[string]searchEntry{}}
	const chunk = 1 << 20
	text := strings.Repeat("a", chunk)
	info := fakeInfo{name: "session.jsonl", size: 1, mod: time.Unix(1, 0)}

	// More files than the budget holds: the cache keeps the newest ones and
	// never goes over.
	files := int(searchCacheBudget/chunk) + 8
	for i := 0; i < files; i++ {
		file := string(rune('a'+i%26)) + strings.Repeat("x", i/26) + ".jsonl"
		cache.store(file, info, text)
		if cache.bytes > searchCacheBudget {
			t.Fatalf("after %d files the cache holds %d bytes, want at most %d", i+1, cache.bytes, searchCacheBudget)
		}
	}
	if len(cache.entries) != int(searchCacheBudget/chunk) {
		t.Errorf("cache holds %d files, want %d", len(cache.entries), searchCacheBudget/chunk)
	}
	if _, ok := cache.lookup("a.jsonl", info); ok {
		t.Error("the first file was still cached; the oldest should have gone")
	}
}

func TestSearchCacheKeepsTheUsedFile(t *testing.T) {
	cache := &searchCache{entries: map[string]searchEntry{}}
	const chunk = 1 << 20
	text := strings.Repeat("a", chunk)
	info := fakeInfo{name: "session.jsonl", size: 1, mod: time.Unix(1, 0)}
	first := "first.jsonl"
	cache.store(first, info, text)
	// Read the first again, so it is the newest rather than the oldest.
	if got, ok := cache.lookup(first, info); !ok || got != text {
		t.Fatalf("lookup of the cached file = %v, want its text", ok)
	}
	fill := int(searchCacheBudget/chunk) - 1
	for i := 0; i < fill; i++ {
		cache.store("fill"+strings.Repeat("x", i)+".jsonl", info, text)
	}
	if _, ok := cache.lookup(first, info); !ok {
		t.Error("the file asked for last was dropped before the ones never asked for again")
	}
}

func TestSearchCacheNoticesAChangedFile(t *testing.T) {
	cache := &searchCache{entries: map[string]searchEntry{}}
	file := "session.jsonl"
	cache.store(file, fakeInfo{name: file, size: 10, mod: time.Unix(1, 0)}, "old")
	if _, ok := cache.lookup(file, fakeInfo{name: file, size: 10, mod: time.Unix(1, 0)}); !ok {
		t.Fatal("an unchanged file was not found")
	}
	if _, ok := cache.lookup(file, fakeInfo{name: file, size: 11, mod: time.Unix(1, 0)}); ok {
		t.Fatal("a file that grew was still served from the cache")
	}
	if _, ok := cache.lookup(file, fakeInfo{name: file, size: 10, mod: time.Unix(2, 0)}); ok {
		t.Fatal("a file rewritten in place was still served from the cache")
	}
	// Storing the same file again counts its text once.
	cache.store(file, fakeInfo{name: file, size: 10, mod: time.Unix(1, 0)}, "old")
	cache.store(file, fakeInfo{name: file, size: 10, mod: time.Unix(1, 0)}, "new text")
	if cache.bytes != int64(len("new text")) {
		t.Errorf("cache counts %d bytes for one file holding %d", cache.bytes, len("new text"))
	}
	if got, ok := cache.lookup(file, fakeInfo{name: file, size: 10, mod: time.Unix(1, 0)}); !ok || got != "new text" {
		t.Errorf("lookup = %q %v, want the newer text", got, ok)
	}
}

func TestSearchCacheDropsAFileOverTheBudget(t *testing.T) {
	cache := &searchCache{entries: map[string]searchEntry{}}
	info := fakeInfo{name: "session.jsonl", size: 1, mod: time.Unix(1, 0)}
	cache.store("huge.jsonl", info, strings.Repeat("a", searchCacheBudget+1))
	if cache.bytes != 0 || len(cache.entries) != 0 {
		t.Fatalf("a file larger than the budget stayed: %d bytes in %d files", cache.bytes, len(cache.entries))
	}
}
