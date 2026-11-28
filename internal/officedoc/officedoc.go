// Package officedoc reads what an Office document says: the words of a Word
// document and the cells of a spreadsheet, for a preview that shows them.
//
// Only the zipped formats are read (.docx, .xlsx): a document is opened as a
// zip archive and its XML read with the standard library, so nothing here
// writes, converts, renders or depends on a host. The older binary formats
// (.doc, .xls) stay the system's own applications' business.
package officedoc

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
)

// What a document refuses with.
var (
	// ErrFormat: the bytes are not a zipped Office document, or the part
	// that holds its content is missing.
	ErrFormat = errors.New("officedoc: not an Office document")
	// ErrPartTooLarge: one part holds more than MaxPart bytes, so the
	// document is refused rather than read into memory.
	ErrPartTooLarge = errors.New("officedoc: document part too large")
)

// maxPart bounds the bytes read of one part of a document, and maxCellBytes
// the bytes one cell keeps: the rest belongs to an editor, not a preview.
const (
	maxPart      = 64 << 20
	maxCellBytes = 2000
)

// openArchive reads data as a zip archive.
func openArchive(data []byte) (*zip.Reader, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrFormat, err)
	}
	return zr, nil
}

// readPart returns the bytes of the named part of an archive.
func readPart(zr *zip.Reader, name string) ([]byte, error) {
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrFormat, err)
		}
		defer rc.Close()
		if f.UncompressedSize64 > maxPart {
			return nil, ErrPartTooLarge
		}
		data, err := io.ReadAll(io.LimitReader(rc, maxPart+1))
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrFormat, err)
		}
		if len(data) > maxPart {
			return nil, ErrPartTooLarge
		}
		return data, nil
	}
	return nil, fmt.Errorf("%w: no %s", ErrFormat, name)
}

// text collects a document's words, one line at a time: it tracks the last
// byte written so a break or a separator does not repeat one.
type text struct {
	b    strings.Builder
	last byte
}

// write appends s.
func (t *text) write(s string) {
	if s == "" {
		return
	}
	t.b.WriteString(s)
	t.last = s[len(s)-1]
}

// empty reports whether nothing was written yet.
func (t *text) empty() bool { return t.b.Len() == 0 }

// lineStart reports whether the next write begins a line.
func (t *text) lineStart() bool { return t.b.Len() == 0 || t.last == '\n' }

// newline ends the current line, once.
func (t *text) newline() {
	if t.b.Len() > 0 && t.last != '\n' {
		t.write("\n")
	}
}

// separate writes sep between two pieces on one line.
func (t *text) separate(sep string) {
	if !t.lineStart() {
		t.write(sep)
	}
}

// string returns what the document said.
func (t *text) string() string { return strings.TrimRight(t.b.String(), "\n\t ") }

// clip shortens s to at most n bytes, backing up to a character boundary.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && (s[n]&0xC0) == 0x80 {
		n--
	}
	return s[:n]
}
