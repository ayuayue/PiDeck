package main

// Checks that listing sessions only reads the files that changed.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSessionMetaCache reuses a listing until its file changes, and still
// applies a renamed title without reading the file again.
func TestSessionMetaCache(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) string {
		path := filepath.Join(st.sessions, name)
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	a := write("a.jsonl", searchSession("a", "C:/work/shop", "部署手册", "怎么发布到生产环境"))
	write("b.jsonl", searchSession("b", "C:/work/blog", "", "写一篇关于并发编程的文章"))

	metas := st.scanSessions(nil)
	if len(metas) != 2 {
		t.Fatalf("first scan = %d sessions, want 2", len(metas))
	}
	if st.parses != 2 {
		t.Fatalf("first scan read %d files, want 2", st.parses)
	}

	// Nothing changed, so nothing is read again.
	if metas = st.scanSessions(nil); len(metas) != 2 || st.parses != 2 {
		t.Fatalf("second scan = %d sessions, %d reads; want 2, 2", len(metas), st.parses)
	}

	// A rename comes from the config, not the file.
	metas = st.scanSessions(map[string]string{"a": "发布手册"})
	found := false
	for _, m := range metas {
		if m.ID == "a" {
			found = true
			if m.Title != "发布手册" {
				t.Fatalf("title after rename = %q", m.Title)
			}
		}
	}
	if !found || st.parses != 2 {
		t.Fatalf("rename scan read %d files, found %v; want 2 reads", st.parses, found)
	}

	// An appended message changes the file and is picked up.
	f, err := os.OpenFile(a, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"type":"message","id":"u2","timestamp":"2026-06-01T10:00:03Z","message":{"role":"user","content":"再来一条"}}` + "\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()
	metas = st.scanSessions(nil)
	for _, m := range metas {
		if m.ID == "a" && m.Count != 3 {
			t.Fatalf("count after append = %d, want 3", m.Count)
		}
	}
	if st.parses != 3 {
		t.Fatalf("append scan read %d files, want 3", st.parses)
	}

	// A file without a session header is skipped, and remembered as such.
	write("b.jsonl", "not a session\n")
	if metas = st.scanSessions(nil); len(metas) != 1 {
		t.Fatalf("scan with a broken file = %d sessions, want 1", len(metas))
	}
	before := st.parses
	if metas = st.scanSessions(nil); len(metas) != 1 || st.parses != before {
		t.Fatalf("broken file was read again: %d reads, want %d", st.parses, before)
	}

	// The settings count only walks the directory.
	if n := st.countSessions(); n != 2 {
		t.Fatalf("countSessions = %d, want 2", n)
	}
	if st.parses != before {
		t.Fatalf("countSessions read %d files, want no reads", st.parses-before)
	}
}

// writeSession puts one session file in a folder of a store.
func writeSession(t *testing.T, dir, name, body string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestMetaCacheSurvivesRestart reuses the saved listings on the next run, so
// a warm start reads no session file at all.
func TestMetaCacheSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(st.sessions, "--C--work--")
	writeSession(t, folder, "a.jsonl", searchSession("a", "C:/work/shop", "部署手册", "怎么发布到生产环境"))
	writeSession(t, folder, "b.jsonl", searchSession("b", "C:/work/blog", "", "写一篇关于并发编程的文章"))

	if metas := st.scanSessions(nil); len(metas) != 2 || st.parses != 2 {
		t.Fatalf("cold scan = %d sessions, %d reads; want 2, 2", len(metas), st.parses)
	}
	st.writeMetaCache()

	again, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	metas := again.scanSessions(nil)
	if len(metas) != 2 || again.parses != 0 {
		t.Fatalf("warm scan = %d sessions, %d reads; want 2, 0", len(metas), again.parses)
	}
	for _, m := range metas {
		if m.ID == "a" && m.Title != "部署手册" {
			t.Fatalf("warm title = %q, want the stored name", m.Title)
		}
		if m.File == "" || m.Updated.IsZero() {
			t.Fatalf("warm listing lost a field: %+v", m)
		}
	}
}

// TestMetaCacheIgnoresAnotherSchema reads every file again after a bump, so
// a field that changed meaning is never served from an old cache.
func TestMetaCacheIgnoresAnotherSchema(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	writeSession(t, filepath.Join(st.sessions, "--C--work--"), "a.jsonl", searchSession("a", "C:/work/shop", "", "第一条"))
	if err := os.WriteFile(st.metaPath, []byte(`{"version":0,"entries":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	again, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if metas := again.scanSessions(nil); len(metas) != 1 || again.parses != 1 {
		t.Fatalf("scan after a bump = %d sessions, %d reads; want 1, 1", len(metas), again.parses)
	}
}

// TestMetaCacheForgetsDeletedSessions drops a listing together with its file,
// so a deleted session does not come back on the next start.
func TestMetaCacheForgetsDeletedSessions(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(st.sessions, "--C--work--")
	writeSession(t, folder, "a.jsonl", searchSession("a", "C:/work/shop", "", "留下"))
	gone := writeSession(t, folder, "b.jsonl", searchSession("b", "C:/work/shop", "", "删掉"))
	st.scanSessions(nil)
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	st.scanSessions(nil)
	st.writeMetaCache()

	raw, err := os.ReadFile(st.metaPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "b.jsonl") {
		t.Fatalf("the deleted session is still cached:\n%s", raw)
	}
	again, err := newStore(st.dir)
	if err != nil {
		t.Fatal(err)
	}
	if metas := again.scanSessions(nil); len(metas) != 1 || metas[0].ID != "a" {
		t.Fatalf("warm scan = %+v, want only a", metas)
	}
}

// TestPiScanReadsOnlyShownProjects keeps the files of other projects at
// their header, so a large store costs what the rail shows, not what this
// machine ever ran.
func TestPiScanReadsOnlyShownProjects(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	writeSession(t, filepath.Join(root, "--C--work-shop--"), "a.jsonl", searchSession("a", "C:/work/shop", "发布手册", "怎么发布"))
	writeSession(t, filepath.Join(root, "--C--work-shop--"), "b.jsonl", searchSession("b", "C:/work/shop", "", "再问一句"))
	writeSession(t, filepath.Join(root, "--C--work-blog--"), "c.jsonl", searchSession("c", "C:/work/blog", "写作计划", "写篇文章"))
	writeSession(t, filepath.Join(root, "--C--work-blog--"), "d.jsonl", searchSession("d", "C:/work/blog", "", "再写一篇"))

	shop := func(cwd string) bool { return cwd == filepath.Clean("C:/work/shop") }
	metas := st.scanPiSessions(root, nil, shop, 0)
	if len(metas) != 2 {
		t.Fatalf("shop scan = %d sessions, want 2", len(metas))
	}
	for _, m := range metas {
		if !m.External || m.Cwd != filepath.Clean("C:/work/shop") {
			t.Fatalf("shop scan returned %+v", m)
		}
	}

	// The same project again reads nothing: unchanged files, and the other
	// project's files are not even stat'd.
	reads := st.parses
	if metas := st.scanPiSessions(root, nil, shop, 0); len(metas) != 2 || st.parses != reads {
		t.Fatalf("warm scan = %d sessions, %d reads; want 2, %d", len(metas), st.parses, reads)
	}

	// Opening the other project reads only its own two files: the first
	// scan took those to their header.
	blog := func(cwd string) bool { return cwd == filepath.Clean("C:/work/blog") }
	metas = st.scanPiSessions(root, nil, blog, 0)
	if len(metas) != 2 || st.parses != reads+2 {
		t.Fatalf("blog scan = %d sessions, %d reads; want 2, %d", len(metas), st.parses, reads+2)
	}
	for _, m := range metas {
		if m.Title == "" || m.Title == "未命名会话" {
			t.Fatalf("blog session has no name: %+v", m)
		}
	}
}

// TestMetaScanReadsOnlyTheAppendedTail keeps a session in use cheap to
// rescan: after an append only the appended bytes are read, and the listing
// stays right.
func TestMetaScanReadsOnlyTheAppendedTail(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := writeSession(t, filepath.Join(st.sessions, "--C--work--"), "a.jsonl",
		searchSession("a", "C:/work/shop", "部署手册", "怎么发布到生产环境"))
	st.scanSessions(nil)
	full := st.consumed
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if full != info.Size() {
		t.Fatalf("first scan read %d bytes of a %d byte file", full, info.Size())
	}

	line := `{"type":"message","id":"u2","timestamp":"2026-06-01T10:00:03Z","message":{"role":"user","content":"再来一条"}}` + "\n"
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(line); err != nil {
		t.Fatal(err)
	}
	f.Close()

	metas := st.scanSessions(nil)
	if got := st.consumed - full; got != int64(len(line)) {
		t.Fatalf("rescan read %d bytes after a %d byte append", got, len(line))
	}
	found := false
	for _, m := range metas {
		if m.ID != "a" {
			continue
		}
		found = true
		if m.Count != 3 || m.Title != "部署手册" {
			t.Fatalf("appended session = %d messages, title %q; want 3 and the stored name", m.Count, m.Title)
		}
	}
	if !found {
		t.Fatal("the appended session is gone from the listing")
	}

	// A rename written at the end of the session is picked up from the tail.
	appendLines(t, path, `{"type":"session_info","name":"发布手册","timestamp":"2026-06-01T10:00:04Z"}`)
	for _, m := range st.scanSessions(nil) {
		if m.ID == "a" && m.Title != "发布手册" {
			t.Fatalf("title after a rename = %q", m.Title)
		}
	}
}

// TestMetaScanRereadsARewrittenFile parses a session again after it was cut
// or rewritten, instead of trusting a tail that no longer follows.
func TestMetaScanRereadsARewrittenFile(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := writeSession(t, filepath.Join(st.sessions, "--C--work--"), "a.jsonl",
		searchSession("a", "C:/work/shop", "部署手册", "怎么发布到生产环境"))
	st.scanSessions(nil)

	// Same size, different bytes: what a compaction looks like from afar.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	raw[0] = 'X'
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	before := st.consumed
	metas := st.scanSessions(nil)
	if len(metas) != 0 {
		t.Fatalf("a rewritten file still lists %d sessions", len(metas))
	}
	if got := st.consumed - before; got != int64(len(raw)) {
		t.Fatalf("rewritten file read %d bytes, want all %d", got, len(raw))
	}
}
