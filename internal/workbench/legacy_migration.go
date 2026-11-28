//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"time"
)

const legacyMigrationFile = "legacy-migration.json"

type legacyMigrationRecord struct {
	Version  int       `json:"version"`
	Status   string    `json:"status"`
	Source   string    `json:"source,omitempty"`
	Started  time.Time `json:"started,omitempty"`
	Finished time.Time `json:"finished,omitempty"`
	Imported int       `json:"imported"`
	Skipped  int       `json:"skipped"`
	Files    int       `json:"files"`
	Error    string    `json:"error,omitempty"`
}

type legacyMigrationResult struct {
	Record   legacyMigrationRecord
	Snapshot legacySnapshot
	Sessions []sessionMeta
	Titles   map[string]string
	Pinned   []string
	Err      error
}

func readLegacyMigration(dir string) (legacyMigrationRecord, error) {
	var record legacyMigrationRecord
	err := readLegacyJSON(filepath.Join(dir, legacyMigrationFile), &record)
	if err == nil && ((record.Version != 0 && record.Version != 1) || (record.Status != "" && record.Version != 1)) {
		err = errors.New("unsupported migration record version")
	}
	if err == nil && record.Status != "" && !slices.Contains([]string{"running", "completed", "failed", "not-found"}, record.Status) {
		err = errors.New("invalid migration record status")
	}
	return record, err
}

func saveLegacyMigration(dir string, record legacyMigrationRecord) error {
	raw, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(dir, legacyMigrationFile), raw, 0o600)
}

func legacyMigrationCandidates() []string {
	if explicit := os.Getenv("PIDECK_V2_LEGACY_HOME"); explicit != "" {
		return []string{explicit}
	}
	// An explicit V2 home is also used for tests and portable isolation.
	// It must not silently import the machine's unrelated Electron profile.
	if os.Getenv("PIDECK_V2_HOME") != "" {
		return nil
	}
	var candidates []string
	if executable, err := os.Executable(); err == nil {
		for _, name := range []string{"data", "data-channel-dev"} {
			candidates = append(candidates, filepath.Join(filepath.Dir(executable), name))
		}
	}
	if root, err := os.UserConfigDir(); err == nil {
		for _, name := range []string{"PiDeck", "pi-desktop", "PiDeck-channel-dev"} {
			candidates = append(candidates, filepath.Join(root, name))
		}
	}
	return candidates
}

func findLegacyMigrationSource(candidates []string, destination string) (string, error) {
	for _, candidate := range candidates {
		root, err := filepath.Abs(candidate)
		if err != nil {
			return "", err
		}
		if pathWithin(root, destination) || pathWithin(destination, root) {
			continue
		}
		info, err := os.Stat(root)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() {
			continue
		}
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			return "", err
		}
		realDestination, err := filepath.EvalSymlinks(destination)
		if err != nil {
			return "", err
		}
		if pathWithin(realRoot, realDestination) || pathWithin(realDestination, realRoot) {
			continue
		}
		for _, name := range []string{"projects.json", "chat-path.json", "session-catalog.json"} {
			if _, err := os.Stat(filepath.Join(root, name)); err == nil {
				return root, nil
			} else if !errors.Is(err, os.ErrNotExist) {
				return "", err
			}
		}
	}
	return "", nil
}

// pathWithin includes equality and uses the platform's path identity rules.
func pathWithin(root, path string) bool {
	rel, err := filepath.Rel(pathKey(root), pathKey(path))
	return err == nil && rel != ".." && !filepath.IsAbs(rel) &&
		(len(rel) < 3 || rel[:3] != ".."+string(filepath.Separator))
}

// runLegacyMigration only copies data. Publishing the new project list and
// saving the terminal marker happen after the UI has merged concurrent edits.
func runLegacyMigration(ctx context.Context, st *store, source string, progress func(sessionTransferState)) legacyMigrationResult {
	result := legacyMigrationResult{Record: legacyMigrationRecord{Version: 1, Status: "running", Source: source, Started: time.Now().UTC()}}
	fail := func(err error) legacyMigrationResult { result.Err = err; return result }
	if pathWithin(source, st.dir) || pathWithin(st.dir, source) {
		return fail(errors.New("legacy source overlaps the destination"))
	}
	if err := saveLegacyMigration(st.dir, result.Record); err != nil {
		return fail(err)
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	snapshot, err := readLegacySnapshot(source, st.dir)
	if err != nil {
		return fail(err)
	}
	result.Snapshot = snapshot
	state := sessionTransferState{Kind: "legacy", Status: "scanning", Source: source, Visible: true}
	progress(state)
	var roots []string
	for _, project := range snapshot.Projects {
		path := project.Path
		if project.Chat {
			path = snapshot.Chat
		}
		roots = append(roots, path)
	}
	roots = piSessionRoots(append(roots, snapshot.Chat))
	roots = append(roots, filepath.Join(source, "sessions"), filepath.Join(source, "external-sessions"))
	var existing []string
	for _, root := range uniqueSessionRoots(roots...) {
		if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return fail(err)
		}
		existing = append(existing, root)
	}
	files, scanErr := scanPiTransferFiles(ctx, existing)
	// Catalog paths may live outside every currently configured sessionDir.
	catalog := map[string]bool{}
	for _, path := range snapshot.Paths {
		catalog[pathKey(path)] = true
	}
	files = slices.DeleteFunc(files, func(path string) bool { return catalog[pathKey(path)] })
	chatFiles, chatErr := legacyChatFiles(ctx, source, snapshot.Chat)
	state.Total = len(chatFiles) + len(snapshot.Paths) + len(files)
	state.Status = "copying"
	progress(state)
	var firstErr error
	keepError := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	keepError(scanErr)
	keepError(chatErr)
	for _, path := range chatFiles {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		rel, err := filepath.Rel(snapshot.Chat, path)
		if err == nil {
			var copied bool
			copied, err = copyLegacyChatFile(ctx, path, filepath.Join(st.dir, "chat"), rel)
			if copied {
				result.Record.Files++
			}
		}
		if err != nil {
			state.Failed++
			keepError(err)
		}
		state.Done++
		state.Files = result.Record.Files
		progress(state)
	}
	allCopied := map[string]sessionMeta{}
	for index, batch := range [][]string{snapshot.Paths, files} {
		base := state
		var allow func(string) bool
		if index == 1 {
			allow = func(cwd string) bool { return snapshot.Allowed[pathKey(cwd)] }
		}
		copied := st.transferPiSessions(ctx, batch, snapshot.CwdMap, allow, func(p piTransferProgress) {
			state.Done = base.Done + p.Done
			state.Imported = base.Imported + p.Imported
			state.Skipped = base.Skipped + p.Skipped
			state.Failed = base.Failed + p.Failed
			progress(state)
		})
		for path, meta := range copied.BySource {
			allCopied[path] = meta
		}
		result.Record.Imported += copied.Imported
		result.Record.Skipped += copied.Skipped
		keepError(copied.Err)
	}
	seen := map[string]bool{}
	for _, meta := range allCopied {
		if !seen[meta.ID] {
			result.Sessions = append(result.Sessions, meta)
			seen[meta.ID] = true
		}
	}
	result.Titles, result.Pinned = snapshot.sessionMetadata(allCopied)
	if err := migrateLegacyTextSettings(source, st.dir); err != nil {
		keepError(err)
	}
	result.Err = firstErr
	if err := ctx.Err(); err != nil {
		result.Err = err
	}
	return result
}
