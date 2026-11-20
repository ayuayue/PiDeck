//go:build !js && !android && !ios

package workbench

// The prompt store: a JSON index of shared prompt packs. Installing one
// downloads the pack and merges it into prompts/user.json, skipping
// titles the library already has.

import (
	"errors"
	"fmt"
	"io"
	"strings"

	yaml "go.yaml.in/yaml/v3"
)

// promptIndexEntry is one pack in an index.
type promptIndexEntry struct {
	ID          string `json:"id" yaml:"id"`
	Name        string `json:"name" yaml:"name"`
	Description string `json:"description" yaml:"description"`
	Author      string `json:"author" yaml:"author"`
	URL         string `json:"url" yaml:"url"`
}

// fetchPromptIndex reads an index of prompt packs.
func fetchPromptIndex(rawURL string) ([]promptIndexEntry, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "https://prompts.chat" || rawURL == communityPromptsURL {
		return []promptIndexEntry{{ID: "prompts-chat", Name: "prompts.chat", Author: "f/prompts.chat", URL: communityPromptsURL}}, nil
	}
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
		Packs []promptIndexEntry `json:"packs" yaml:"packs"`
	}
	if yaml.Unmarshal(raw, &index) != nil || len(index.Packs) == 0 {
		var list []promptIndexEntry
		if yaml.Unmarshal(raw, &list) != nil || len(list) == 0 {
			return nil, errors.New("不是提示词索引")
		}
		index.Packs = list
	}
	var out []promptIndexEntry
	seen := map[string]bool{}
	for _, e := range index.Packs {
		e.ID = strings.TrimSpace(e.ID)
		e.Name = strings.TrimSpace(e.Name)
		e.URL = strings.TrimSpace(e.URL)
		if e.ID == "" || e.Name == "" || !isHTTPURL(e.URL) || seen[e.ID] {
			continue
		}
		seen[e.ID] = true
		out = append(out, e)
		if len(out) >= 200 {
			break
		}
	}
	if len(out) == 0 {
		return nil, errors.New("索引里没有可用的提示词包")
	}
	return out, nil
}

// installPromptIndexEntry downloads and merges one pack.
func (a *app) installPromptIndexEntry(e promptIndexEntry) (int, int, error) {
	pack, err := fetchPromptPack(e.URL)
	if err != nil {
		return 0, 0, err
	}
	return a.importPromptPack(pack)
}
