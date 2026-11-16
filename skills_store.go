//go:build !js

package main

// The skill store: a JSON index of shared SKILL.md files. Installing one
// downloads it into pi's skills folder, where pi picks it up.

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"go.yaml.in/yaml/v3"
)

// skillIndexEntry is one skill in an index.
type skillIndexEntry struct {
	ID          string `json:"id" yaml:"id"`
	Name        string `json:"name" yaml:"name"`
	Description string `json:"description" yaml:"description"`
	Author      string `json:"author" yaml:"author"`
	URL         string `json:"url" yaml:"url"`
}

// fetchSkillIndex reads an index of skills, in {skills:[...]} or a bare
// list.
func fetchSkillIndex(rawURL string) ([]skillIndexEntry, error) {
	rawURL = strings.TrimSpace(rawURL)
	if !isHTTPURL(rawURL) {
		return nil, errors.New("索引链接只支持 http(s)")
	}
	resp, err := appHTTPClient.Get(rawURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var index struct {
		Skills []skillIndexEntry `json:"skills" yaml:"skills"`
	}
	if yaml.Unmarshal(raw, &index) != nil || len(index.Skills) == 0 {
		var list []skillIndexEntry
		if yaml.Unmarshal(raw, &list) != nil || len(list) == 0 {
			return nil, errors.New("不是技能索引")
		}
		index.Skills = list
	}
	var out []skillIndexEntry
	seen := map[string]bool{}
	for _, e := range index.Skills {
		e.ID = strings.TrimSpace(e.ID)
		e.Name = strings.TrimSpace(e.Name)
		e.URL = strings.TrimSpace(e.URL)
		if e.ID == "" || e.Name == "" || !isHTTPURL(e.URL) || !marketID.MatchString(e.ID) || seen[e.ID] {
			continue
		}
		seen[e.ID] = true
		out = append(out, e)
		if len(out) >= 200 {
			break
		}
	}
	if len(out) == 0 {
		return nil, errors.New("索引里没有可用的技能")
	}
	return out, nil
}

// skillInstallDir is the folder a skill id installs into.
func skillInstallDir(id string) (string, error) {
	if !marketID.MatchString(id) {
		return "", errors.New("技能 id 只能包含字母、数字、点、下划线和短横线")
	}
	dirs := skillsDirs()
	if len(dirs) == 0 {
		return "", errors.New("找不到 pi 配置目录")
	}
	return filepath.Join(dirs[0], id), nil
}

// installSkill downloads one SKILL.md into pi's skills folder.
func installSkill(e skillIndexEntry) (string, error) {
	dir, err := skillInstallDir(e.ID)
	if err != nil {
		return "", err
	}
	if !isHTTPURL(e.URL) {
		return "", errors.New("技能链接只支持 http(s)")
	}
	resp, err := appHTTPClient.Get(e.URL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("下载技能失败：HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 512<<10))
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(string(raw)) == "" {
		return "", errors.New("下载到的 SKILL.md 是空的")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "SKILL.md")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// skillInstalled reports whether a skill id already has its SKILL.md.
func skillInstalled(id string) bool {
	dir, err := skillInstallDir(id)
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(dir, "SKILL.md"))
	return err == nil
}
