package main

// Checks that a session file is read only where the last read stopped.

import (
	"os"
	"path/filepath"
	"testing"
)

// writeLines writes body to a fresh file and returns its path.
func writeLines(t *testing.T, lines ...string) string {
	t.Helper()
	body := ""
	for _, l := range lines {
		body += l + "\n"
	}
	path := filepath.Join(t.TempDir(), "tail.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// appendLines adds lines to a file, the way pi grows a session.
func appendLines(t *testing.T, path string, lines ...string) int64 {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range lines {
		if _, err := f.WriteString(l + "\n"); err != nil {
			t.Fatal(err)
		}
	}
	f.Close()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

// TestParsedTailResumesOnAppend reads the new tail of a file that grew, and
// nothing when it was rewritten or cut.
func TestParsedTailResumesOnAppend(t *testing.T) {
	path := writeLines(t, `{"type":"session","id":"a"}`, `{"type":"message","id":"m1"}`)
	var seen []string
	tail, err := readTail(path, 0, func(line []byte) error {
		seen = append(seen, string(line))
		return nil
	})
	if err != nil || len(seen) != 2 {
		t.Fatalf("first read = %d lines, %v; want 2", len(seen), err)
	}
	size := appendLines(t, path, `{"type":"message","id":"m2"}`)
	if got := tail.resumeAt(path, size); got != tail.Consumed {
		t.Fatalf("resume at %d, want %d", got, tail.Consumed)
	}
	seen = nil
	next, err := readTail(path, tail.Consumed, func(line []byte) error {
		seen = append(seen, string(line))
		return nil
	})
	if err != nil || len(seen) != 1 || seen[0] != `{"type":"message","id":"m2"}` {
		t.Fatalf("tail read = %q, %v; want the appended line", seen, err)
	}
	if next.Consumed != size {
		t.Fatalf("tail read stopped at %d, want %d", next.Consumed, size)
	}

	// A file rewritten in place keeps its size but not the bytes before the
	// stopping point, so it is read again from the top.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	raw[0] = 'X'
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	size = appendLines(t, path, `{"type":"message","id":"m3"}`)
	if got := next.resumeAt(path, size); got != 0 {
		t.Fatalf("resume after a rewrite = %d, want 0", got)
	}

	// A file that shrank is a compaction: read it all.
	if got := next.resumeAt(path, next.Consumed-1); got != 0 {
		t.Fatalf("resume of a shorter file = %d, want 0", got)
	}
}

// TestParsedTailWaitsForTheNewline keeps a half-written last line for the
// next read instead of parsing it twice or losing it.
func TestParsedTailWaitsForTheNewline(t *testing.T) {
	path := writeLines(t, `{"type":"session","id":"a"}`)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"type":"message","id":"m1"`); err != nil {
		t.Fatal(err)
	}
	f.Close()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	lines := 0
	tail, err := readTail(path, 0, func([]byte) error {
		lines++
		return nil
	})
	if err != nil || lines != 1 {
		t.Fatalf("read of a half-written file = %d lines, %v; want 1", lines, err)
	}
	if tail.Consumed >= info.Size() {
		t.Fatalf("consumed %d of %d bytes, want the last line left out", tail.Consumed, info.Size())
	}

	size := appendLines(t, path, `}`)
	if got := tail.resumeAt(path, size); got != tail.Consumed {
		t.Fatalf("resume at %d, want %d", got, tail.Consumed)
	}
	var got string
	if _, err := readTail(path, tail.Consumed, func(line []byte) error {
		got = string(line)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if got != `{"type":"message","id":"m1"}` {
		t.Fatalf("completed line = %q", got)
	}
}
