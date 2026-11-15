package main

// Checks that listing sessions only reads the files that changed.

import (
	"os"
	"path/filepath"
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
