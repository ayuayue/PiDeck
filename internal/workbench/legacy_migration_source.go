//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Legacy records belong to Electron. Only local pi data has a matching
// runtime here; credentials, plugins and remote-host identities stay there.
type legacyProject struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	Kind        string `json:"kind"`
	Environment string `json:"environment"`
	Pinned      bool   `json:"pinned"`
	CreatedAt   int64  `json:"createdAt"`
	SortOrder   int    `json:"sortOrder"`
	Locator     struct {
		Kind        string `json:"kind"`
		Environment string `json:"environment"`
		LocalPath   string `json:"localPath"`
	} `json:"locator"`
}

type legacySession struct {
	ID               string   `json:"id"`
	ProjectID        string   `json:"projectId"`
	PiSessionID      string   `json:"piSessionId"`
	Title            string   `json:"title"`
	FilePath         string   `json:"filePath"`
	Backend          string   `json:"backend"`
	Environment      string   `json:"environment"`
	MergedSessionIDs []string `json:"mergedSessionIds"`
	Locator          struct {
		Kind        string `json:"kind"`
		Environment string `json:"environment"`
		FilePath    string `json:"filePath"`
	} `json:"locator"`
}

type legacySnapshot struct {
	Projects []workspaceCfg
	Sessions []legacySession
	Chat     string
	CwdMap   map[string]string
	Allowed  map[string]bool
	Paths    []string
	Pinned   map[string]bool
}

// readLegacyJSON never creates, repairs or writes an Electron file.
func readLegacyJSON(path string, out any) error {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("invalid legacy file: %s", filepath.Base(path))
	}
	const limit = 16 << 20
	raw, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return err
	}
	if len(raw) > limit {
		return fmt.Errorf("legacy file exceeds 16 MiB: %s", filepath.Base(path))
	}
	if err := json.Unmarshal(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf}), out); err != nil {
		return fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	return nil
}

func readLegacySnapshot(source, destination string) (legacySnapshot, error) {
	out := legacySnapshot{Chat: filepath.Join(source, "chat-workspace"),
		CwdMap: map[string]string{}, Allowed: map[string]bool{}, Pinned: map[string]bool{}}
	var chat struct {
		Path string `json:"path"`
	}
	if err := readLegacyJSON(filepath.Join(source, "chat-path.json"), &chat); err != nil {
		return out, err
	}
	if chat.Path != "" {
		if !filepath.IsAbs(chat.Path) {
			return out, errors.New("legacy chat path is not absolute")
		}
		out.Chat = filepath.Clean(chat.Path)
	}
	newChat := filepath.Join(destination, "chat")
	moveChat := pathWithin(source, out.Chat)
	if moveChat {
		out.CwdMap[pathKey(out.Chat)] = newChat
	}
	out.Allowed[pathKey(out.Chat)] = true
	var projectRaw json.RawMessage
	if err := readLegacyJSON(filepath.Join(source, "projects.json"), &projectRaw); err != nil {
		return out, err
	}
	var projects []legacyProject
	if len(projectRaw) > 0 {
		if projectRaw[0] == '[' {
			if err := json.Unmarshal(projectRaw, &projects); err != nil {
				return out, err
			}
		} else {
			var envelope struct {
				Version  int             `json:"schemaVersion"`
				Projects []legacyProject `json:"projects"`
			}
			if err := json.Unmarshal(projectRaw, &envelope); err != nil {
				return out, err
			}
			if envelope.Version != 2 {
				return out, errors.New("unsupported legacy projects version")
			}
			projects = envelope.Projects
		}
	}
	slices.SortStableFunc(projects, func(a, b legacyProject) int {
		if a.SortOrder < b.SortOrder {
			return -1
		}
		if a.SortOrder > b.SortOrder {
			return 1
		}
		return 0
	})
	for _, p := range projects {
		if p.Locator.Kind == "ssh" || p.Environment == "wsl" || p.Locator.Environment == "wsl" {
			continue
		}
		path := firstNonEmpty(p.Locator.LocalPath, p.Path)
		if !filepath.IsAbs(path) {
			continue
		}
		path = filepath.Clean(path)
		isChat := p.Kind == "chat" || pathKey(path) == pathKey(out.Chat)
		out.Allowed[pathKey(path)] = true
		if isChat && moveChat {
			out.CwdMap[pathKey(path)] = newChat
			path = newChat
		}
		added := time.Time{}
		if p.CreatedAt > 0 {
			added = time.UnixMilli(p.CreatedAt).UTC()
		}
		out.Projects = append(out.Projects, workspaceCfg{Path: path, Name: p.Name, Chat: isChat && moveChat,
			Pinned: p.Pinned || isChat, Added: added, Expanded: true})
	}
	var catalog struct {
		Version  int             `json:"version"`
		Sessions []legacySession `json:"sessions"`
	}
	if err := readLegacyJSON(filepath.Join(source, "session-catalog.json"), &catalog); err != nil {
		return out, err
	}
	if catalog.Version != 0 && catalog.Version != 1 {
		return out, errors.New("unsupported legacy session catalog version")
	}
	for _, entry := range catalog.Sessions {
		if (entry.Backend != "" && entry.Backend != "pi") || entry.Environment == "wsl" ||
			entry.Locator.Environment == "wsl" || entry.Locator.Kind == "ssh" {
			continue
		}
		entry.FilePath = firstNonEmpty(entry.Locator.FilePath, entry.FilePath)
		if filepath.IsAbs(entry.FilePath) {
			out.Paths = append(out.Paths, filepath.Clean(entry.FilePath))
			out.Sessions = append(out.Sessions, entry)
		}
	}
	var settings struct {
		Pinned []string `json:"pinnedSessionIds"`
	}
	if err := readLegacyJSON(filepath.Join(source, "settings.json"), &settings); err != nil {
		return out, err
	}
	for _, id := range settings.Pinned {
		out.Pinned[id] = true
	}
	return out, nil
}

func (snapshot legacySnapshot) sessionMetadata(copied map[string]sessionMeta) (map[string]string, []string) {
	titles, pinned := map[string]string{}, []string{}
	for _, entry := range snapshot.Sessions {
		meta, ok := copied[filepath.Clean(entry.FilePath)]
		if !ok {
			continue
		}
		if title := strings.TrimSpace(entry.Title); title != "" {
			titles[meta.ID] = title
		}
		isPinned := snapshot.Pinned[entry.ID] || snapshot.Pinned[entry.PiSessionID]
		for _, alias := range entry.MergedSessionIDs {
			isPinned = isPinned || snapshot.Pinned[alias]
		}
		if isPinned && !slices.Contains(pinned, meta.ID) {
			pinned = append(pinned, meta.ID)
		}
	}
	return titles, pinned
}
