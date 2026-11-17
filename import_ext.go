//go:build !js && !android && !ios

package main

// Importing one session file the user picked: pi's own file is copied as it
// is, so the original keeps its identity; another agent's log is converted
// by its source, and the copy lands in this app's store under the folder
// the session ran in.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// readHeadBytes reads the first bytes of a file, for sniffing its format.
func readHeadBytes(path string, n int64) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	head, _ := io.ReadAll(io.LimitReader(f, n))
	return head
}

// sniffPi says whether a file is a pi session: its first record has the
// session header's shape.
func sniffPi(head []byte) bool {
	sc := bufio.NewScanner(bytes.NewReader(head))
	sc.Buffer(make([]byte, 0, 8<<10), 1<<20)
	for i := 0; i < 4 && sc.Scan(); i++ {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var entry struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if json.Unmarshal(line, &entry) == nil {
			return entry.Type == "session" && entry.ID != ""
		}
	}
	return false
}

// importDisplayTitle names an imported session in the rail: the tool it came
// from, so a converted session reads as one.
func importDisplayTitle(source importSource, title string) string {
	if title = importTitle(title); title == "" {
		return source.Label + " · " + T("未命名会话")
	}
	return source.Label + " · " + title
}

// writeFileImport writes one picked file's parsed session for cwd.
func (s *store) writeFileImport(source importSource, path string, parsed importedSession, cwd string) (sessionMeta, error) {
	// A database session's path names the row, not a file: only a file's
	// size and time are worth reading.
	var size int64
	var mtime time.Time
	if info, err := os.Stat(path); err == nil {
		size, mtime = info.Size(), info.ModTime()
	}
	id := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	c := importCandidate{Source: source.Key, ID: id, Path: path, Cwd: parsed.Cwd, Title: parsed.Title,
		Size: size, MTime: mtime}
	updated := parsed.Updated
	if updated.IsZero() {
		updated = mtime
	}
	title := importDisplayTitle(source, firstNonEmpty(parsed.Title, firstUserText(parsed.Messages)))
	if strings.TrimSpace(cwd) == "" {
		cwd = firstNonEmpty(parsed.Cwd, ".")
	}
	return s.writeImported(source, c, parsed, filepath.Clean(cwd), title, updated)
}

// sourceForFile says which source wrote a file, by sniffing it.
func sourceForFile(path string) (*importSource, []byte) {
	head := readHeadBytes(path, 256<<10)
	if len(head) == 0 {
		return nil, nil
	}
	for _, source := range importSources {
		if source.Sniff == nil || !source.Sniff(head) {
			continue
		}
		return source, head
	}
	return nil, head
}

// noSourceForFile explains a file none of the sources recognize.
func noSourceForFile(head []byte) error {
	if len(head) == 0 {
		return fmt.Errorf("这个文件是空的")
	}
	return fmt.Errorf("认不出这个会话文件的格式")
}
