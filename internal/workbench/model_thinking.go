//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"errors"
	"example.com/pideck/internal/apptext"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var piSettingsFileMu sync.Mutex

func readModelThinkingDefault(provider, id string) (string, error) {
	if !validModelThinkingReference(provider, id) {
		return "", invalidAdvancedModel()
	}
	piSettingsFileMu.Lock()
	defer piSettingsFileMu.Unlock()
	_, table, _, err := readModelThinkingSettings()
	if err != nil || table == nil {
		return "", err
	}
	value, _ := table[modelThinkingReference(provider, id)].(string)
	return strings.TrimSpace(value), nil
}

func saveModelThinkingDefault(provider, id, level string) error {
	if !validModelThinkingReference(provider, id) {
		return invalidAdvancedModel()
	}
	level = strings.TrimSpace(level)
	return updateModelThinkingSettings(func(root, table map[string]any, exists bool) (bool, error) {
		key := modelThinkingReference(provider, id)
		old, hadOld := table[key]
		if level == "" {
			if !hadOld {
				return false, nil
			}
			delete(table, key)
		} else {
			if current, ok := old.(string); ok && current == level {
				return false, nil
			}
			if !exists {
				table = map[string]any{}
			}
			table[key] = level
		}
		return true, writeModelThinkingSettings(root, table)
	})
}

func migrateModelThinkingReferences(provider, oldID, newID string) error {
	if !validModelThinkingReference(provider, oldID) || (newID != "" && !validModelThinkingReference(provider, newID)) {
		return invalidAdvancedModel()
	}
	if oldID == newID {
		return nil
	}
	return updateModelThinkingSettings(func(root, table map[string]any, exists bool) (bool, error) {
		if !exists {
			return false, nil
		}
		oldKey := modelThinkingReference(provider, oldID)
		value, ok := table[oldKey]
		if !ok {
			return false, nil
		}
		delete(table, oldKey)
		if newID != "" {
			table[modelThinkingReference(provider, newID)] = value
		}
		return true, writeModelThinkingSettings(root, table)
	})
}

func updateModelThinkingSettings(change func(map[string]any, map[string]any, bool) (bool, error)) error {
	piSettingsFileMu.Lock()
	defer piSettingsFileMu.Unlock()
	root, table, exists, err := readModelThinkingSettings()
	if err != nil {
		return err
	}
	changed, err := change(root, table, exists)
	if err != nil || !changed {
		return err
	}
	return nil
}

func readModelThinkingSettings() (map[string]any, map[string]any, bool, error) {
	path := piSettingsPath()
	if path == "" {
		return nil, nil, false, errors.New(apptext.T("找不到 pi 的配置目录"))
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{}, nil, false, nil
	}
	var root map[string]any
	if err != nil || json.Unmarshal(raw, &root) != nil || root == nil {
		return nil, nil, false, errors.New(apptext.T("pi 设置无法读取；请检查 settings.json 后重试。"))
	}
	tableValue, exists := root["modelThinkingLevels"]
	if !exists {
		return root, nil, false, nil
	}
	table, ok := tableValue.(map[string]any)
	if !ok {
		return nil, nil, false, errors.New(apptext.T("pi 设置无法读取；请检查 settings.json 后重试。"))
	}
	return root, table, true, nil
}

func writeModelThinkingSettings(root, table map[string]any) error {
	if len(table) == 0 {
		delete(root, "modelThinkingLevels")
	} else {
		root["modelThinkingLevels"] = table
	}
	data, err := json.MarshalIndent(root, "", "  ")
	path := piSettingsPath()
	if err != nil {
		return errors.New(apptext.T("保存 pi 设置失败"))
	}
	if path == "" {
		return errors.New(apptext.T("找不到 pi 的配置目录"))
	}
	if os.MkdirAll(filepath.Dir(path), 0o700) != nil || writeFileAtomic(path, append(data, '\n'), 0o600) != nil {
		return errors.New(apptext.T("保存 pi 设置失败"))
	}
	return nil
}

func validModelThinkingReference(provider, id string) bool {
	return strings.TrimSpace(provider) != "" && strings.TrimSpace(id) != "" && provider == strings.TrimSpace(provider) && id == strings.TrimSpace(id)
}

func modelThinkingReference(provider, id string) string { return provider + "/" + id }
