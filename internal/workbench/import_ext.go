//go:build !js && !android && !ios

package workbench

// Importing one session file the user picked: pi's own file is copied as it
// is, so the original keeps its identity; another agent's log is converted
// by its source, and the copy lands in this app's store under the folder
// the session ran in.

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"example.com/pideck-lite/internal/sessionimport"
)

// writeFileImport writes one picked file's parsed session for cwd.
func (s *store) writeFileImport(source sessionimport.Source, path string, parsed sessionimport.Session, cwd string) (sessionMeta, error) {
	// A database session's path names the row, not a file: only a file's
	// size and time are worth reading.
	var size int64
	var mtime time.Time
	if info, err := os.Stat(path); err == nil {
		size, mtime = info.Size(), info.ModTime()
	}
	id := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	c := sessionimport.Candidate{Source: source.Key, ID: id, Path: path, Cwd: parsed.Cwd, Title: parsed.Title,
		Size: size, MTime: mtime}
	updated := parsed.Updated
	if updated.IsZero() {
		updated = mtime
	}
	title := sessionimport.DisplayTitle(source, firstNonEmpty(parsed.Title, sessionimport.FirstUserText(parsed.Messages)))
	if strings.TrimSpace(cwd) == "" {
		cwd = firstNonEmpty(parsed.Cwd, ".")
	}
	return s.writeImported(source, c, parsed, filepath.Clean(cwd), title, updated)
}
