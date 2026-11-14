package main

// The plugin market: a JSON index of single-file plugin manifests. The
// index is the user's own link (a team server, a gist); installing
// downloads one manifest into plugins/ and reloads the add-ons. Only the
// declarative manifest is installed, never code.

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

// marketEntry is one plugin in an index.
type marketEntry struct {
	ID          string `json:"id" yaml:"id"`
	Name        string `json:"name" yaml:"name"`
	Description string `json:"description" yaml:"description"`
	Version     string `json:"version" yaml:"version"`
	Author      string `json:"author" yaml:"author"`
	URL         string `json:"url" yaml:"url"`
}

// fetchPluginIndex reads an index of plugin manifests.
func fetchPluginIndex(rawURL string) ([]marketEntry, error) {
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
		Plugins []marketEntry `json:"plugins" yaml:"plugins"`
	}
	if yaml.Unmarshal(raw, &index) != nil || len(index.Plugins) == 0 {
		var list []marketEntry
		if yaml.Unmarshal(raw, &list) != nil || len(list) == 0 {
			return nil, errors.New("不是插件索引")
		}
		index.Plugins = list
	}
	var out []marketEntry
	seen := map[string]bool{}
	for _, e := range index.Plugins {
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
		return nil, errors.New("索引里没有可用的插件")
	}
	return out, nil
}

// isHTTPURL says whether a link is one the app will fetch.
func isHTTPURL(s string) bool {
	return strings.HasPrefix(s, "https://") || strings.HasPrefix(s, "http://")
}

// marketID is a plugin id safe for a file name.
var marketID = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// installMarketPlugin downloads one manifest and writes it into plugins/.
func (a *app) installMarketPlugin(entry marketEntry) (plugin, error) {
	var out plugin
	dir := a.pluginsDir()
	if dir == "" {
		return out, errors.New("找不到插件目录")
	}
	if !isHTTPURL(entry.URL) {
		return out, errors.New("插件链接只支持 http(s)")
	}
	resp, err := appHTTPClient.Get(entry.URL)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return out, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 512<<10))
	if err != nil {
		return out, err
	}
	if err := yaml.Unmarshal(raw, &out); err != nil {
		return out, fmt.Errorf("清单不是有效的 JSON/YAML：%w", err)
	}
	if out.Name == "" {
		out.Name = entry.Name
	}
	if out.ID == "" {
		out.ID = entry.ID
	}
	out.ID = strings.TrimSpace(out.ID)
	if entry.ID != "" && out.ID != entry.ID {
		return out, fmt.Errorf("清单 id %q 与索引 %q 不一致", out.ID, entry.ID)
	}
	if !marketID.MatchString(out.ID) {
		return out, errors.New("插件 id 只能有字母、数字、点、下划线和横线")
	}
	out.Dir = dir
	normalizePlugin(&out)
	if len(out.Commands) == 0 && len(out.ThemeSpecs) == 0 &&
		len(out.Contributes.Settings) == 0 && len(out.Contributes.Hooks) == 0 {
		return out, errors.New("插件没有任何命令、主题、设置或 hooks")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return out, err
	}
	path := filepath.Join(dir, out.ID+".json")
	if _, err := os.Stat(path); err == nil {
		return out, errors.New("已经安装过这个插件")
	}
	if err := writeFileAtomic(path, raw, 0o644); err != nil {
		return out, err
	}
	out.Path = path
	return out, nil
}

// pluginInstalled reports whether a plugin with this id is loaded.
func (a *app) pluginInstalled(id string) bool {
	return a.installedPlugin(id) != nil
}

// installedPlugin finds a loaded plugin by id.
func (a *app) installedPlugin(id string) *plugin {
	if a.plugins == nil {
		return nil
	}
	for _, p := range a.plugins.GetUntracked() {
		if p.ID == id {
			cp := p
			return &cp
		}
	}
	return nil
}
