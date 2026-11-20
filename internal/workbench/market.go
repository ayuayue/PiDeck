//go:build !js && !android && !ios

package workbench

// The plugin market: a JSON index of single-file plugin manifests. The
// index is the user's own link (a team server, a gist); installing
// downloads one manifest into plugins/ and reloads the add-ons. Only the
// declarative manifest is installed, never code.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	yaml "go.yaml.in/yaml/v3"
)

// marketEntry is one plugin in an index.
type marketEntry struct {
	External    bool   `json:"-" yaml:"-"`
	Builtin     bool   `json:"-" yaml:"-"`
	Runtime     string `json:"runtime" yaml:"runtime"`
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
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	raw, err := downloadCatalogData(ctx, rawURL, 1<<20)
	if err != nil {
		return nil, err
	}
	// Official mixed registries carry repository coordinates. Keep the
	// original custom {plugins:[{id,name,url}]} index and bare array valid.
	var registry struct {
		SchemaVersion int
		Plugins       []struct{ Repo string }
	}
	if json.Unmarshal(raw, &registry) == nil && registry.SchemaVersion != 0 {
		if registry.SchemaVersion != 1 {
			return parseOfficialPlugins(raw)
		}
		for _, entry := range registry.Plugins {
			if entry.Repo != "" {
				return parseOfficialPlugins(raw)
			}
		}
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
		// The legacy custom index is a Lite index. A mixed index must name
		// foreign runtimes explicitly; unknown runtimes stay discovery-only.
		if e.Runtime == "" {
			e.Runtime = litePluginRuntime
		}
		e.External = e.Runtime != litePluginRuntime
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
	if entry.External || (entry.Runtime != "" && entry.Runtime != litePluginRuntime) {
		return out, errors.New(apptext.T("插件清单不兼容：%s", firstNonEmpty(entry.Runtime, "unknown")))
	}
	dir := a.pluginsDir()
	if dir == "" {
		return out, errors.New("找不到插件目录")
	}
	if !marketID.MatchString(entry.ID) || entry.ID == "." || entry.ID == ".." {
		return out, errors.New("插件 id 只能有字母、数字、点、下划线和横线")
	}
	path, previous, err := marketPluginTarget(dir, entry.ID)
	if err != nil {
		return out, err
	}
	if !entry.Builtin && !isHTTPURL(entry.URL) {
		return out, errors.New("插件链接只支持 http(s)")
	}
	var raw []byte
	if entry.Builtin {
		raw, err = pluginExamples.ReadFile("plugin_examples/" + entry.ID + ".json")
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		raw, err = downloadCatalogData(ctx, entry.URL, 512<<10)
	}
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
	if entry.Version != "" && out.Version != entry.Version {
		return out, errors.New(apptext.T("清单版本 %s 与索引 %s 不一致", out.Version, entry.Version))
	}
	if len(previous) > 0 {
		var old plugin
		if err := yaml.Unmarshal(previous, &old); err != nil {
			return out, err
		}
		if !normalizePluginIdentity(&old) {
			return out, errors.New(old.Error)
		}
		if entry.Version == "" || old.Version == "" || old.Version == entry.Version {
			return out, errors.New("已经安装过这个插件")
		}
	}
	out.Dir = filepath.Dir(path)
	normalizePlugin(&out)
	if out.Error != "" {
		return out, errors.New(out.Error)
	}
	if !out.hasContributions() {
		return out, errors.New(apptext.T("插件没有可用的贡献项"))
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return out, err
	}
	current, err := readMarketManifest(path)
	if (err != nil && !os.IsNotExist(err)) || !bytes.Equal(current, previous) {
		return out, errors.New(apptext.T("插件文件已变化，请重新加载后重试"))
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
