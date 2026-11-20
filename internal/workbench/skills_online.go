//go:build !js && !android && !ios

package workbench

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

func parseSkillsSearch(raw []byte) ([]skillIndexEntry, error) {
	var result struct {
		Skills []struct{ ID, Name, Source string }
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	var list []skillIndexEntry
	seen := map[string]bool{}
	for _, s := range result.Skills {
		parts := strings.Split(s.Source, "/")
		if len(parts) != 2 || !validCatalogSegment(parts[0]) || !validCatalogSegment(parts[1]) {
			continue
		}
		slug := path.Base(s.ID)
		if !validCatalogSegment(slug) || s.Name == "" {
			continue
		}
		sum := sha256.Sum256([]byte(s.Source + "/" + slug))
		id := "online-" + hex.EncodeToString(sum[:6]) + "-" + slug
		if seen[id] {
			continue
		}
		seen[id] = true
		list = append(list, skillIndexEntry{ID: id, Name: s.Name, Author: s.Source, URL: "https://skills.sh/api/download/" + url.PathEscape(parts[0]) + "/" + url.PathEscape(parts[1]) + "/" + url.PathEscape(slug), Snapshot: true})
		if len(list) >= 50 {
			break
		}
	}
	if len(list) == 0 {
		return nil, errors.New("skills.sh returned no matching skills")
	}
	return list, nil
}

func (a *app) searchOnlineSkills() {
	query := strings.TrimSpace(a.skillStoreURL.GetUntracked())
	if query == "" || isHTTPURL(query) {
		query = "coding"
	}
	a.skillStoreURL.Set("https://skills.sh/api/search?q=" + url.QueryEscape(query) + "&limit=30")
	a.loadSkillIndex()
}

func installSkillSnapshot(e skillIndexEntry) (string, error) {
	u, err := url.Parse(e.URL)
	if err != nil || u.Scheme != "https" || u.Host != "skills.sh" || !strings.HasPrefix(u.Path, "/api/download/") {
		return "", errors.New("untrusted skills.sh snapshot URL")
	}
	dir, err := skillInstallDir(e.ID)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	raw, err := downloadCatalogData(ctx, e.URL, 8<<20)
	if err != nil {
		return "", err
	}
	return installSkillSnapshotData(dir, raw)
}

// Snapshot installation is all-or-nothing and never executes its scripts.
// Auxiliary reference files stay beside SKILL.md, not silently discarded.
func installSkillSnapshotData(dir string, raw []byte) (string, error) {
	if len(raw) > 8<<20 {
		return "", errors.New("skill snapshot exceeds size limit")
	}
	var snapshot struct {
		Files []struct{ Path, Contents string }
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return "", err
	}
	if len(snapshot.Files) == 0 || len(snapshot.Files) > 512 {
		return "", errors.New("invalid skill snapshot file count")
	}
	seen := map[string]bool{}
	hasSkill := false
	total := 0
	for _, f := range snapshot.Files {
		key := strings.ToLower(f.Path)
		if f.Path == "." || !fs.ValidPath(f.Path) || !filepath.IsLocal(f.Path) || len(f.Path) > 256 || strings.ContainsAny(f.Path, "\\:\x00") || seen[key] || len(f.Contents) > 2<<20 {
			return "", errors.New("invalid skill snapshot path or size")
		}
		for _, segment := range strings.Split(f.Path, "/") {
			if strings.TrimRight(segment, " .") != segment || segment == ".git" {
				return "", errors.New("invalid skill snapshot path")
			}
		}
		seen[key] = true
		total += len(f.Contents)
		if total > 8<<20 {
			return "", errors.New("skill snapshot exceeds size limit")
		}
		if f.Path == "SKILL.md" && strings.TrimSpace(f.Contents) != "" {
			hasSkill = true
		}
	}
	if !hasSkill {
		return "", errors.New("skill snapshot has no SKILL.md")
	}
	if _, err := os.Lstat(dir); err == nil {
		return "", errors.New("skill is already installed")
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	parent := filepath.Dir(dir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(parent, ".pideck-skill-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	root, err := os.OpenRoot(stage)
	if err != nil {
		return "", err
	}
	for _, f := range snapshot.Files {
		if err := root.MkdirAll(path.Dir(f.Path), 0o755); err != nil {
			root.Close()
			return "", err
		}
		if err := root.WriteFile(f.Path, []byte(f.Contents), 0o644); err != nil {
			root.Close()
			return "", err
		}
	}
	if err := root.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(stage, dir); err != nil {
		return "", err
	}
	return filepath.Join(dir, "SKILL.md"), nil
}
