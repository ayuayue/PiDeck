//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"example.com/pideck-v2/internal/apptext"
	yaml "go.yaml.in/yaml/v3"
)

// marketPluginTarget finds the manifest that owns an ID, including folder
// plugins and flat files whose name differs from their ID. Updates retain
// that location and its assets, rather than creating a competing plugin.
func marketPluginTarget(dir, id string) (string, []byte, error) {
	target := filepath.Join(dir, id+".json")
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return target, nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	var previous []byte
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			path = filepath.Join(path, "plugin.json")
		} else if !isJSONFile(entry.Name()) {
			continue
		}
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			if path == target {
				return "", nil, fmt.Errorf("%s", apptext.T("插件文件已变化，请重新加载后重试"))
			}
			continue
		}
		raw, err := readMarketManifest(path)
		if err != nil {
			return "", nil, err
		}
		var p plugin
		if err := yaml.Unmarshal(raw, &p); err != nil {
			if path == target {
				return "", nil, err
			}
			continue
		}
		loadedID := firstNonEmpty(p.ID, p.Name, fileBase(entry.Name()))
		if loadedID != id {
			if path == target {
				return "", nil, fmt.Errorf("%s", apptext.T("插件文件已变化，请重新加载后重试"))
			}
			continue
		}
		if previous != nil {
			return "", nil, fmt.Errorf("%s", apptext.T("存在重复的插件 id：%s", id))
		}
		target, previous = path, raw
	}
	return target, previous, nil
}

func readMarketManifest(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, (512<<10)+1))
	if err == nil && len(raw) > 512<<10 {
		err = fmt.Errorf("%s", apptext.T("插件清单超过 512 KB"))
	}
	return raw, err
}
