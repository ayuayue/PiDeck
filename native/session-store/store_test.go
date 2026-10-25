package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fixture struct {
	t         *testing.T
	root      string
	statePath string
	store     *Store
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	return &fixture{
		t:         t,
		root:      filepath.Join(dir, "sessions"),
		statePath: filepath.Join(dir, "state", "state.bin"),
		store:     OpenStore(filepath.Join(dir, "state", "state.bin")),
	}
}

func (f *fixture) path(rel string) string {
	return filepath.Join(f.root, filepath.FromSlash(rel))
}

func (f *fixture) write(rel string, content string) {
	f.t.Helper()
	target := f.path(rel)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		f.t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		f.t.Fatalf("write %s: %v", rel, err)
	}
}

func (f *fixture) append(rel string, content string) {
	f.t.Helper()
	handle, err := os.OpenFile(f.path(rel), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		f.t.Fatalf("open for append: %v", err)
	}
	defer handle.Close()
	if _, err := handle.WriteString(content); err != nil {
		f.t.Fatalf("append: %v", err)
	}
}

func (f *fixture) list() listStats {
	f.t.Helper()
	stats, err := f.store.ListFiles([]string{f.root})
	if err != nil {
		f.t.Fatalf("list files: %v", err)
	}
	return stats
}

func (f *fixture) state(rel string) fileState {
	f.t.Helper()
	stats := f.list()
	for _, file := range stats.Files {
		if file.Path == f.path(rel) {
			return file
		}
	}
	f.t.Fatalf("file not in list: %s", rel)
	return fileState{}
}

func messageLine(id string, text string) string {
	return `{"type":"message","id":"` + id + `","message":{"role":"user","content":[{"type":"text","text":"` + text + `"}]}}` + "\n"
}

func TestListFilesScansThenReusesUnchangedFiles(t *testing.T) {
	fx := newFixture(t)
	fx.write("a.jsonl", messageLine("a1", "hello"))
	fx.write("b.jsonl", messageLine("b1", "world"))

	first := fx.list()
	if first.Full != 2 || first.Reused != 0 || first.Incremental != 0 {
		t.Fatalf("first pass = %+v, want full=2 reused=0", first)
	}
	if len(first.Files) != 2 {
		t.Fatalf("files = %d, want 2", len(first.Files))
	}

	second := fx.list()
	if second.Reused != 2 || second.Full != 0 || second.Incremental != 0 {
		t.Fatalf("second pass = %+v, want reused=2 full=0", second)
	}
}

func TestAppendScansOnlyTail(t *testing.T) {
	fx := newFixture(t)
	fx.write("a.jsonl", messageLine("a1", "hello"))
	fx.list()

	fx.append("a.jsonl", messageLine("a2", "more"))
	stats := fx.list()
	if stats.Incremental != 1 || stats.Full != 0 {
		t.Fatalf("after append = %+v, want incremental=1 full=0", stats)
	}
	state := stats.Files[0]
	if state.EntryCount != 2 {
		t.Fatalf("entry count = %d, want 2", state.EntryCount)
	}
	if !state.EndsWithNewline {
		t.Fatalf("expected endsWithNewline=true")
	}
}

func TestPartialTailIsNotCommitted(t *testing.T) {
	fx := newFixture(t)
	fx.write("a.jsonl", messageLine("a1", "hello"))
	before := fx.state("a.jsonl")

	fx.append("a.jsonl", `{"type":"message","id":"a2"`)
	partial := fx.state("a.jsonl")
	if partial.Size != before.Size {
		t.Fatalf("partial tail advanced committed size: %d -> %d", before.Size, partial.Size)
	}
	if partial.EntryCount != before.EntryCount {
		t.Fatalf("partial tail counted an entry: %d -> %d", before.EntryCount, partial.EntryCount)
	}
	if partial.EndsWithNewline {
		t.Fatalf("partial tail should clear endsWithNewline")
	}

	fx.append("a.jsonl", "}\n")
	final := fx.state("a.jsonl")
	if final.EntryCount != before.EntryCount+1 {
		t.Fatalf("completed line not counted: %d", final.EntryCount)
	}
	if !final.EndsWithNewline {
		t.Fatalf("completed file should end with newline")
	}
}

func TestShrunkFileIsFullyRescanned(t *testing.T) {
	fx := newFixture(t)
	fx.write("a.jsonl", messageLine("a1", "one")+messageLine("a2", "two")+messageLine("a3", "three"))
	fx.list()

	fx.write("a.jsonl", messageLine("a9", "only"))
	stats := fx.list()
	if stats.Full != 1 || stats.Incremental != 0 {
		t.Fatalf("after shrink = %+v, want full=1", stats)
	}
	if stats.Files[0].EntryCount != 1 {
		t.Fatalf("entry count = %d, want 1", stats.Files[0].EntryCount)
	}
}

func TestCompactionFlagIsStickyAcrossIncrementalScan(t *testing.T) {
	fx := newFixture(t)
	fx.write("a.jsonl", messageLine("a1", "hello"))
	fx.list()

	fx.append("a.jsonl", `{"type":"compaction","id":"c1"}`+"\n")
	if state := fx.state("a.jsonl"); !state.HasCompaction {
		t.Fatalf("compaction line not detected")
	}

	fx.append("a.jsonl", messageLine("a2", "after"))
	if state := fx.state("a.jsonl"); !state.HasCompaction {
		t.Fatalf("compaction flag lost after incremental scan")
	}
}

func TestScanIgnoresNonSessionEntries(t *testing.T) {
	fx := newFixture(t)
	fx.write("a.jsonl", messageLine("a1", "kept")+
		`{"type":"session","id":"s1"}`+"\n"+
		`{"type":"message"}`+"\n"+
		"not json at all\n")
	fx.write(".pideck-archive/archived.jsonl", messageLine("z1", "archived"))
	fx.write("subagent-artifacts/agent.jsonl", messageLine("z2", "agent"))
	fx.write("notes.txt", "ignored")

	stats := fx.list()
	if len(stats.Files) != 1 {
		t.Fatalf("files = %d, want 1 (%+v)", len(stats.Files), stats.Files)
	}
	// 只有「带字符串 id 的完整行」计入（与 TS 侧 index 口径一致，session 头行也算）；
	// 无 id 行、非 JSON 行都不算：a1 + s1 = 2。
	if stats.Files[0].EntryCount != 2 {
		t.Fatalf("entry count = %d, want 2", stats.Files[0].EntryCount)
	}
}

func TestRemovedFileIsPrunedFromSnapshot(t *testing.T) {
	fx := newFixture(t)
	fx.write("a.jsonl", messageLine("a1", "hello"))
	fx.write("b.jsonl", messageLine("b1", "world"))
	fx.list()

	if err := os.Remove(fx.path("a.jsonl")); err != nil {
		t.Fatalf("remove: %v", err)
	}
	stats := fx.list()
	if stats.Pruned != 1 || len(stats.Files) != 1 {
		t.Fatalf("after remove = %+v, want pruned=1 files=1", stats)
	}

	reopened := OpenStore(fx.statePath)
	if reopened.SnapshotSize() != 1 {
		t.Fatalf("snapshot size = %d, want 1", reopened.SnapshotSize())
	}
}

func TestSnapshotReloadSkipsRescan(t *testing.T) {
	fx := newFixture(t)
	fx.write("a.jsonl", messageLine("a1", "hello"))
	fx.list()

	reopened := OpenStore(fx.statePath)
	fx.store = reopened
	stats := fx.list()
	if stats.Reused != 1 || stats.Full != 0 || stats.Incremental != 0 {
		t.Fatalf("reloaded store = %+v, want reused=1", stats)
	}
}

func TestCorruptSnapshotStartsEmpty(t *testing.T) {
	fx := newFixture(t)
	fx.write("a.jsonl", messageLine("a1", "hello"))
	if err := os.MkdirAll(filepath.Dir(fx.statePath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(fx.statePath, []byte("{not json"), 0o644); err != nil {
		t.Fatalf("write corrupt snapshot: %v", err)
	}

	fx.store = OpenStore(fx.statePath)
	stats := fx.list()
	if stats.Full != 1 || stats.Reused != 0 {
		t.Fatalf("corrupt snapshot = %+v, want full=1", stats)
	}
}

func TestLargeLineWithInlineAttachmentStillCounts(t *testing.T) {
	fx := newFixture(t)
	blob := strings.Repeat("A", 2*1024*1024)
	fx.write("a.jsonl", `{"type":"message","id":"big1","attachment":"`+blob+`"}`+"\n"+messageLine("a2", "after"))

	state := fx.state("a.jsonl")
	if state.EntryCount != 2 {
		t.Fatalf("entry count = %d, want 2", state.EntryCount)
	}
}
