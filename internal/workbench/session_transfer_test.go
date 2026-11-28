//go:build !js && !android && !ios

package workbench

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func piTransferTestStore(t *testing.T) *store {
	t.Helper()
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func piTransferTestSession(t *testing.T, file, id, cwd, body string) []byte {
	t.Helper()
	head, err := json.Marshal(map[string]any{
		"type": "session", "version": 3, "id": id, "cwd": cwd,
		"timestamp": "2026-01-02T03:04:05.123Z", "parentSession": "parent-id",
		"future": json.RawMessage(`{"precise":9007199254740993,"nested":[true,{"key":"value"}]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	raw := append(append(head, '\n'), []byte(body)...)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return raw
}

func piTransferTestRead(t *testing.T, file string) []byte {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func piTransferTestFiles(t *testing.T, root string) []string {
	t.Helper()
	files, err := scanPiTransferFiles(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestScanPiTransferFilesNestedAndDeduplicated(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "nested", "deeper", "first.jsonl")
	second := filepath.Join(root, "second.JSONL")
	piTransferTestSession(t, first, "first", root, "")
	piTransferTestSession(t, second, "second", root, "")
	piTransferTestSession(t, filepath.Join(root, "ignore.txt"), "ignored", root, "")
	if err := os.Mkdir(filepath.Join(root, "directory.jsonl"), 0o755); err != nil {
		t.Fatal(err)
	}
	files, err := scanPiTransferFiles(context.Background(), []string{root, filepath.Dir(first), first, filepath.Join(root, "."), ""})
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]bool)
	for _, file := range files {
		if !filepath.IsAbs(file) || seen[pathKey(file)] {
			t.Fatalf("non-absolute or repeated file: %q", file)
		}
		seen[pathKey(file)] = true
	}
	if len(files) != 2 || !seen[pathKey(first)] || !seen[pathKey(second)] {
		t.Fatalf("files = %v, want the two nested JSONL files", files)
	}
	if _, err := scanPiTransferFiles(context.Background(), []string{filepath.Join(root, "missing")}); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing root error = %v, want os.ErrNotExist", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, roots := range [][]string{nil, {root}} {
		if _, err := scanPiTransferFiles(ctx, roots); !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled scan error = %v", err)
		}
	}
}

func TestScanPiTransferFilesDoesNotFollowSymlinks(t *testing.T) {
	t.Run("symlinks", func(t *testing.T) {
		root, outside := t.TempDir(), t.TempDir()
		inside := filepath.Join(root, "inside.jsonl")
		external := filepath.Join(outside, "outside.jsonl")
		piTransferTestSession(t, inside, "inside", root, "")
		piTransferTestSession(t, external, "outside", outside, "")
		for _, link := range []struct{ target, name string }{
			{external, filepath.Join(root, "file-link.jsonl")},
			{outside, filepath.Join(root, "dir-link")},
			{root, filepath.Join(root, "cycle")},
		} {
			if err := os.Symlink(link.target, link.name); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
		}
		files, err := scanPiTransferFiles(context.Background(), []string{root, filepath.Join(root, "dir-link"), filepath.Join(root, "file-link.jsonl")})
		if err != nil || len(files) != 1 || files[0] != inside {
			t.Fatalf("files = %v, %v; want only the ordinary inside file", files, err)
		}
	})
}

func TestPiTransferPreservesSourceUnknownFieldsAndTime(t *testing.T) {
	st := piTransferTestStore(t)
	src := filepath.Join(t.TempDir(), "source.jsonl")
	cwd := filepath.Join(t.TempDir(), "project")
	body := `{"type":"message","timestamp":"2026-01-02T03:04:06Z","message":{"role":"user","content":"original question"}}` + "\n" +
		`{"type":"future-body","payload":"` + strings.Repeat("x", 2*piTransferHeaderLimit) + `"}` + "\n"
	raw := piTransferTestSession(t, src, "preserved-id", cwd, body)
	mtime := time.Date(2025, 12, 20, 12, 30, 40, 0, time.UTC)
	if err := os.Chtimes(src, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(src)
	if err != nil {
		t.Fatal(err)
	}
	var updates []piTransferProgress
	result := st.transferPiSessions(context.Background(), []string{src}, nil, nil, func(p piTransferProgress) { updates = append(updates, p) })
	if result.Err != nil || result.Imported != 1 || result.Skipped != 0 || result.Failed != 0 {
		t.Fatalf("result = %+v", result)
	}
	meta, found := result.BySource[src]
	created, _ := time.Parse(time.RFC3339Nano, "2026-01-02T03:04:05.123Z")
	if !found || meta.ID != "preserved-id" || meta.Cwd != cwd || !meta.Created.Equal(created) || meta.Count != 1 || meta.Title != "original question" {
		t.Fatalf("imported meta = %+v, found = %v", meta, found)
	}
	if !bytes.Equal(piTransferTestRead(t, src), raw) || !bytes.Equal(piTransferTestRead(t, meta.File), raw) {
		t.Fatal("unmapped import changed source, unknown fields, or body")
	}
	after, err := os.Stat(meta.File)
	if err != nil || !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("imported mtime = %v, %v; want %v", after, err, before.ModTime())
	}
	if filepath.Dir(meta.File) != filepath.Join(st.sessions, encodeCwd(cwd)) || !strings.HasSuffix(meta.File, "_preserved-id.jsonl") {
		t.Fatalf("unexpected destination: %q", meta.File)
	}
	if len(updates) != 2 || updates[0] != (piTransferProgress{Total: 1}) || updates[1] != (piTransferProgress{Done: 1, Total: 1, Imported: 1}) {
		t.Fatalf("progress = %+v", updates)
	}
}

func TestPiTransferCwdMappingOnlyChangesHeaderAndAllowsOriginalCwd(t *testing.T) {
	st := piTransferTestStore(t)
	root := t.TempDir()
	oldCwd, newCwd := filepath.Join(root, "old"), filepath.Join(root, "new")
	otherCwd := filepath.Join(root, "excluded")
	quoted, _ := json.Marshal(oldCwd)
	body := fmt.Sprintf("{\"type\":\"future\",\"cwd\":%s,\"text\":%s}\r\n", quoted, quoted)
	kept, excluded := filepath.Join(root, "keep.jsonl"), filepath.Join(root, "exclude.jsonl")
	raw := piTransferTestSession(t, kept, "mapped-id", oldCwd, body)
	excludedRaw := piTransferTestSession(t, excluded, "excluded-id", otherCwd, body)
	var allowed []string
	result := st.transferPiSessions(context.Background(), []string{kept, excluded}, map[string]string{pathKey(oldCwd): newCwd}, func(cwd string) bool {
		allowed = append(allowed, cwd)
		return cwd == oldCwd
	}, nil)
	if result.Err != nil || result.Imported != 1 || result.Skipped != 1 || result.Failed != 0 || len(result.BySource) != 1 {
		t.Fatalf("result = %+v", result)
	}
	if len(allowed) != 2 || allowed[0] != oldCwd || allowed[1] != otherCwd {
		t.Fatalf("allow saw %v, want original cwd values", allowed)
	}
	meta := result.BySource[kept]
	imported := bytes.SplitN(piTransferTestRead(t, meta.File), []byte{'\n'}, 2)
	original := bytes.SplitN(raw, []byte{'\n'}, 2)
	var mapped, source map[string]json.RawMessage
	if json.Unmarshal(imported[0], &mapped) != nil || json.Unmarshal(original[0], &source) != nil {
		t.Fatal("header is not valid JSON")
	}
	var cwd string
	if err := json.Unmarshal(mapped["cwd"], &cwd); err != nil || cwd != newCwd || meta.Cwd != newCwd {
		t.Fatalf("mapped cwd = %q, meta = %+v, error = %v", cwd, meta, err)
	}
	delete(mapped, "cwd")
	delete(source, "cwd")
	mappedRaw, _ := json.Marshal(mapped)
	sourceRaw, _ := json.Marshal(source)
	if !bytes.Equal(mappedRaw, sourceRaw) || !bytes.Equal(imported[1], original[1]) {
		t.Fatal("cwd mapping changed an unknown header field or body bytes")
	}
	if filepath.Dir(meta.File) != filepath.Join(st.sessions, encodeCwd(newCwd)) {
		t.Fatalf("mapped destination = %q", meta.File)
	}
	if !bytes.Equal(piTransferTestRead(t, kept), raw) || !bytes.Equal(piTransferTestRead(t, excluded), excludedRaw) {
		t.Fatal("mapping or filtering changed a source file")
	}
}

func TestPiTransferDeduplicatesHeaderIDsWithoutOverwriting(t *testing.T) {
	t.Run("existing unconventional filename", func(t *testing.T) {
		st := piTransferTestStore(t)
		cwd := t.TempDir()
		existing := filepath.Join(st.sessions, "nested", "arbitrary-name.jsonl")
		original := piTransferTestSession(t, existing, "existing-id", cwd, `{"type":"session_info","name":"keep this"}`+"\n")
		src := filepath.Join(t.TempDir(), "new.jsonl")
		source := piTransferTestSession(t, src, "existing-id", t.TempDir(), "replacement body\n")
		result := st.transferPiSessions(context.Background(), []string{src}, nil, nil, nil)
		if result.Err != nil || result.Imported != 0 || result.Skipped != 1 || result.Failed != 0 || result.BySource[src].File != existing {
			t.Fatalf("duplicate result = %+v", result)
		}
		if !bytes.Equal(piTransferTestRead(t, existing), original) || !bytes.Equal(piTransferTestRead(t, src), source) || len(piTransferTestFiles(t, st.sessions)) != 1 {
			t.Fatal("duplicate import changed existing content or created another copy")
		}
		if _, err := st.importSession(src); err == nil || err.Error() != "这个会话已经导入过了" {
			t.Fatalf("legacy duplicate error = %v", err)
		}
	})
	t.Run("same batch", func(t *testing.T) {
		st := piTransferTestStore(t)
		root := t.TempDir()
		first, second := filepath.Join(root, "first.jsonl"), filepath.Join(root, "second.jsonl")
		original := piTransferTestSession(t, first, "shared-id", root, "original\n")
		piTransferTestSession(t, second, "shared-id", root, "replacement\n")
		result := st.transferPiSessions(context.Background(), []string{first, second, first}, nil, nil, nil)
		if result.Err != nil || result.Imported != 1 || result.Skipped != 2 || result.Failed != 0 || len(result.BySource) != 2 || result.BySource[first].File != result.BySource[second].File {
			t.Fatalf("same-batch duplicate result = %+v", result)
		}
		if !bytes.Equal(piTransferTestRead(t, result.BySource[first].File), original) || len(piTransferTestFiles(t, st.sessions)) != 1 {
			t.Fatal("same-batch duplicate replaced the first copy")
		}
	})
}

func TestPiTransferContinuesAfterFailuresAndBoundsErrors(t *testing.T) {
	st := piTransferTestStore(t)
	root := t.TempDir()
	broken, unsafe, oversized := filepath.Join(root, "broken.jsonl"), filepath.Join(root, "unsafe.jsonl"), filepath.Join(root, "oversized.jsonl")
	if err := os.WriteFile(broken, []byte(`{"type":"session","id":`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	piTransferTestSession(t, unsafe, "../escape", root, "")
	if err := os.WriteFile(oversized, []byte(`{"type":"session","id":"large","padding":"`+strings.Repeat("x", piTransferHeaderLimit)+`"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(root, "directory.jsonl")
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	nonPi, good := filepath.Join(root, "other.jsonl"), filepath.Join(root, "good.jsonl")
	if err := os.WriteFile(nonPi, []byte("{\"type\":\"message\",\"text\":\"other format\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	piTransferTestSession(t, good, "good-id", root, "")
	files := []string{broken, unsafe, oversized, filepath.Join(root, "missing.jsonl"), directory, nonPi, good}
	var updates []piTransferProgress
	result := st.transferPiSessions(context.Background(), files, nil, nil, func(p piTransferProgress) { updates = append(updates, p) })
	if result.Err == nil || result.Imported != 1 || result.Skipped != 1 || result.Failed != 5 || len(result.BySource) != 1 || result.BySource[good].ID != "good-id" {
		t.Fatalf("mixed result = %+v", result)
	}
	if !strings.Contains(result.Err.Error(), filepath.Base(broken)) || len(result.Err.Error()) > 1024 {
		t.Fatalf("first error was lost or unbounded: %v", result.Err)
	}
	if len(updates) != len(files)+1 {
		t.Fatalf("progress calls = %d, want %d", len(updates), len(files)+1)
	}
	for i, update := range updates {
		if update.Done != i || update.Total != len(files) || update.Imported+update.Skipped+update.Failed != i {
			t.Fatalf("progress[%d] = %+v", i, update)
		}
	}
	repeated := make([]string, 128)
	for i := range repeated {
		repeated[i] = broken
	}
	result = st.transferPiSessions(context.Background(), repeated, nil, nil, nil)
	if result.Failed != len(repeated) || result.Err == nil || len(result.Err.Error()) > 1024 {
		t.Fatalf("repeated failures = %+v", result)
	}
	if _, err := st.importSession(nonPi); err == nil {
		t.Fatal("legacy import accepted non-pi JSONL")
	}
	if _, err := st.importSession(broken); err == nil {
		t.Fatal("legacy import accepted a damaged pi header")
	}
}

func TestPiTransferRejectsUnsafeHeaderIDs(t *testing.T) {
	for i, id := range []string{"", ".", "..", "../escape", `..\escape`, "bad:id", "bad*id", "bad[id]", "bad\x00id", "trailing.", "trailing ", strings.Repeat("x", 129)} {
		t.Run(fmt.Sprintf("id_%d", i), func(t *testing.T) {
			st := piTransferTestStore(t)
			src := filepath.Join(t.TempDir(), "source.jsonl")
			piTransferTestSession(t, src, id, t.TempDir(), "")
			result := st.transferPiSessions(context.Background(), []string{src}, nil, nil, nil)
			if result.Err == nil || result.Failed != 1 || result.Imported != 0 || len(result.BySource) != 0 || len(piTransferTestFiles(t, st.sessions)) != 0 {
				t.Fatalf("unsafe ID result = %+v", result)
			}
		})
	}
}

func TestPiTransferCancellation(t *testing.T) {
	t.Run("before work", func(t *testing.T) {
		st := piTransferTestStore(t)
		src := filepath.Join(t.TempDir(), "source.jsonl")
		piTransferTestSession(t, src, "cancel-before", t.TempDir(), "")
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		var updates []piTransferProgress
		result := st.transferPiSessions(ctx, []string{src}, nil, nil, func(p piTransferProgress) { updates = append(updates, p) })
		if !errors.Is(result.Err, context.Canceled) || result.Imported != 0 || result.Failed != 0 || len(result.BySource) != 0 || len(piTransferTestFiles(t, st.sessions)) != 0 || len(updates) != 1 || updates[0].Done != 0 {
			t.Fatalf("pre-canceled result = %+v, progress = %+v", result, updates)
		}
	})
	t.Run("between files", func(t *testing.T) {
		st := piTransferTestStore(t)
		root := t.TempDir()
		first, second := filepath.Join(root, "first.jsonl"), filepath.Join(root, "second.jsonl")
		piTransferTestSession(t, first, "cancel-first", root, "")
		piTransferTestSession(t, second, "cancel-second", root, "")
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		var updates []piTransferProgress
		result := st.transferPiSessions(ctx, []string{first, second}, nil, nil, func(p piTransferProgress) {
			updates = append(updates, p)
			if p.Done == 1 {
				cancel()
			}
		})
		if !errors.Is(result.Err, context.Canceled) || result.Imported != 1 || result.Failed != 0 || len(result.BySource) != 1 || result.BySource[first].ID != "cancel-first" || len(piTransferTestFiles(t, st.sessions)) != 1 {
			t.Fatalf("mid-batch canceled result = %+v", result)
		}
		if len(updates) != 2 || updates[1].Done != 1 || updates[1].Total != 2 {
			t.Fatalf("canceled progress = %+v", updates)
		}
	})
	t.Run("waiting for import mutex", func(t *testing.T) {
		st := piTransferTestStore(t)
		st.importMu.Lock()
		defer st.importMu.Unlock()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		started := make(chan struct{})
		finished := make(chan piTransferResult, 1)
		go func() {
			finished <- st.transferPiSessions(ctx, []string{"unused.jsonl"}, nil, nil, func(piTransferProgress) { close(started) })
		}()
		<-started
		cancel()
		select {
		case result := <-finished:
			if !errors.Is(result.Err, context.Canceled) || result.Imported != 0 {
				t.Fatalf("waiting canceled result = %+v", result)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("cancellation waited for the active import to release its mutex")
		}
	})
}

type piTransferCancelReader struct {
	r      io.Reader
	cancel context.CancelFunc
}

func (r piTransferCancelReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	r.cancel()
	return n, err
}

type piTransferFailReader struct{ err error }

func (r piTransferFailReader) Read([]byte) (int, error) { return 0, r.err }

func TestPiTransferCopyCleansOwnTemporaryFile(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		t.Run(fmt.Sprintf("canceled_%t", canceled), func(t *testing.T) {
			st := piTransferTestStore(t)
			cwd := t.TempDir()
			src := filepath.Join(t.TempDir(), "source.jsonl")
			raw := piTransferTestSession(t, src, "cleanup-id", cwd, "")
			head, pi, err := readPiTransferHeader(bufio.NewReader(bytes.NewReader(raw)))
			if err != nil || !pi {
				t.Fatalf("fixture header = %v, pi = %v", err, pi)
			}
			info, err := os.Stat(src)
			if err != nil {
				t.Fatal(err)
			}
			folder := filepath.Join(st.sessions, encodeCwd(cwd))
			if err := os.MkdirAll(folder, 0o755); err != nil {
				t.Fatal(err)
			}
			other := filepath.Join(folder, ".pideck-other-writer.tmp")
			if err := os.WriteFile(other, []byte("keep"), 0o600); err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(st.sessions)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			failure := errors.New("body read failed")
			var body io.Reader = piTransferFailReader{failure}
			wantErr := failure
			if canceled {
				body = piTransferCancelReader{strings.NewReader(strings.Repeat("payload", 8192)), cancel}
				wantErr = context.Canceled
			}
			if _, err := copyPiTransferSession(ctx, root, head, body, info); !errors.Is(err, wantErr) {
				t.Fatalf("copy error = %v, want %v", err, wantErr)
			}
			entries, err := os.ReadDir(folder)
			if err != nil || len(entries) != 1 || entries[0].Name() != filepath.Base(other) || string(piTransferTestRead(t, other)) != "keep" {
				t.Fatalf("temporary cleanup changed another writer's file or left data: %v, %v", entries, err)
			}
		})
	}
}

func TestPiTransferSymlinkSafety(t *testing.T) {
	t.Run("source symlink", func(t *testing.T) {
		st := piTransferTestStore(t)
		root := t.TempDir()
		src, link := filepath.Join(root, "source.jsonl"), filepath.Join(root, "link.jsonl")
		original := piTransferTestSession(t, src, "source-link-id", root, "")
		if err := os.Symlink(src, link); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		result := st.transferPiSessions(context.Background(), []string{link, src}, nil, nil, nil)
		if result.Err == nil || result.Failed != 1 || result.Imported != 1 || len(result.BySource) != 1 || !bytes.Equal(piTransferTestRead(t, src), original) {
			t.Fatalf("source symlink result = %+v", result)
		}
	})
	t.Run("destination directory escape", func(t *testing.T) {
		st := piTransferTestStore(t)
		outside, cwd := t.TempDir(), t.TempDir()
		folder := filepath.Join(st.sessions, encodeCwd(cwd))
		if err := os.Symlink(outside, folder); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		src := filepath.Join(t.TempDir(), "source.jsonl")
		piTransferTestSession(t, src, "target-link-id", cwd, "")
		result := st.transferPiSessions(context.Background(), []string{src}, nil, nil, nil)
		if result.Err == nil || result.Failed != 1 || result.Imported != 0 || len(result.BySource) != 0 {
			t.Fatalf("escaping destination result = %+v", result)
		}
		entries, err := os.ReadDir(outside)
		if err != nil || len(entries) != 0 {
			t.Fatalf("wrote through destination symlink: %v, %v", entries, err)
		}
	})
	t.Run("existing symlinks do not reserve IDs", func(t *testing.T) {
		st := piTransferTestStore(t)
		outside := t.TempDir()
		external := filepath.Join(outside, "external.jsonl")
		original := piTransferTestSession(t, external, "external-link-id", outside, "keep\n")
		if err := os.Symlink(external, filepath.Join(st.sessions, "external.jsonl")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if err := os.Symlink(outside, filepath.Join(st.sessions, "external-dir")); err != nil {
			t.Skipf("directory symlinks unavailable: %v", err)
		}
		src := filepath.Join(t.TempDir(), "source.jsonl")
		piTransferTestSession(t, src, "external-link-id", t.TempDir(), "own copy\n")
		result := st.transferPiSessions(context.Background(), []string{src}, nil, nil, nil)
		if result.Err != nil || result.Imported != 1 || result.Skipped != 0 || result.BySource[src].File == external || !bytes.Equal(piTransferTestRead(t, external), original) {
			t.Fatalf("existing symlink result = %+v", result)
		}
	})
}

func TestPiTransferConcurrentBatchesDeduplicate(t *testing.T) {
	st := piTransferTestStore(t)
	root := t.TempDir()
	first, second := filepath.Join(root, "first.jsonl"), filepath.Join(root, "second.jsonl")
	firstRaw := piTransferTestSession(t, first, "concurrent-id", root, "first\n")
	secondRaw := piTransferTestSession(t, second, "concurrent-id", root, "second\n")
	start := make(chan struct{})
	results := make(chan piTransferResult, 2)
	var wg sync.WaitGroup
	for _, src := range []string{first, second} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results <- st.transferPiSessions(context.Background(), []string{src}, nil, nil, nil)
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	imported, skipped := 0, 0
	var destination string
	for result := range results {
		if result.Err != nil || result.Failed != 0 || len(result.BySource) != 1 {
			t.Fatalf("concurrent result = %+v", result)
		}
		imported += result.Imported
		skipped += result.Skipped
		for _, meta := range result.BySource {
			if destination != "" && destination != meta.File {
				t.Fatalf("concurrent batches returned different destinations: %q, %q", destination, meta.File)
			}
			destination = meta.File
		}
	}
	if imported != 1 || skipped != 1 || len(piTransferTestFiles(t, st.sessions)) != 1 {
		t.Fatalf("concurrent counts = imported %d, skipped %d", imported, skipped)
	}
	raw := piTransferTestRead(t, destination)
	if !bytes.Equal(raw, firstRaw) && !bytes.Equal(raw, secondRaw) {
		t.Fatal("concurrent imports mixed file contents")
	}
}

func TestPiTransferHeaderWithoutTrailingNewline(t *testing.T) {
	st := piTransferTestStore(t)
	src := filepath.Join(t.TempDir(), "source.jsonl")
	raw := piTransferTestSession(t, src, "no-newline-id", t.TempDir(), "")
	raw = bytes.TrimSuffix(raw, []byte{'\n'})
	if err := os.WriteFile(src, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	meta, err := st.importSession(src)
	if err != nil || meta.ID != "no-newline-id" || !bytes.Equal(piTransferTestRead(t, meta.File), raw) {
		t.Fatalf("header without trailing newline: meta = %+v, error = %v", meta, err)
	}
}
