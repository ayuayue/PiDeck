package main

// pi's own settings.json, for the fields the app can show as controls.
// Everything else in the file is kept as it was.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/oneo-me/nsgo/ui"
)

// piSettings is the part of pi's settings the app edits.
type piSettings struct {
	HideThinking      bool
	QuietStartup      bool
	CollapseChangelog bool
	DefaultThinking   string
	RetryEnabled      bool
	RetryMax          int
	CompactionEnabled bool
	ReserveTokens     int
	KeepRecentTokens  int
	// Loaded says settings.json was read, not just defaulted.
	Loaded bool
}

// piSettingsPath is pi's settings file.
func piSettingsPath() string {
	dir := piConfigDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "settings.json")
}

// readPiSettings reads the editable fields, defaulting what is missing.
func readPiSettings() (piSettings, error) {
	var out piSettings
	path := piSettingsPath()
	if path == "" {
		return out, fmt.Errorf("找不到 pi 的配置目录")
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return out, fmt.Errorf("settings.json 不是有效的 JSON：%w", err)
	}
	out.Loaded = true
	out.HideThinking, _ = root["hideThinkingBlock"].(bool)
	out.QuietStartup, _ = root["quietStartup"].(bool)
	out.CollapseChangelog, _ = root["collapseChangelog"].(bool)
	out.DefaultThinking, _ = root["defaultThinkingLevel"].(string)
	if retry, _ := root["retry"].(map[string]any); retry != nil {
		out.RetryEnabled, _ = retry["enabled"].(bool)
		out.RetryMax = intField(retry["maxRetries"])
	}
	if compaction, _ := root["compaction"].(map[string]any); compaction != nil {
		out.CompactionEnabled, _ = compaction["enabled"].(bool)
		out.ReserveTokens = intField(compaction["reserveTokens"])
		out.KeepRecentTokens = intField(compaction["keepRecentTokens"])
	}
	return out, nil
}

// savePiSettings writes the editable fields back, keeping the rest.
func savePiSettings(s piSettings) error {
	path := piSettingsPath()
	if path == "" {
		return fmt.Errorf("找不到 pi 的配置目录")
	}
	root := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(raw, &root); err != nil {
			return fmt.Errorf("settings.json 不是有效的 JSON：%w", err)
		}
	}
	if root == nil {
		root = map[string]any{}
	}
	root["hideThinkingBlock"] = s.HideThinking
	root["quietStartup"] = s.QuietStartup
	root["collapseChangelog"] = s.CollapseChangelog
	if s.DefaultThinking == "" {
		delete(root, "defaultThinkingLevel")
	} else {
		root["defaultThinkingLevel"] = s.DefaultThinking
	}
	retry, _ := root["retry"].(map[string]any)
	if retry == nil {
		retry = map[string]any{}
		root["retry"] = retry
	}
	retry["enabled"] = s.RetryEnabled
	setInt(retry, "maxRetries", s.RetryMax)
	compaction, _ := root["compaction"].(map[string]any)
	if compaction == nil {
		compaction = map[string]any{}
		root["compaction"] = compaction
	}
	compaction["enabled"] = s.CompactionEnabled
	setInt(compaction, "reserveTokens", s.ReserveTokens)
	setInt(compaction, "keepRecentTokens", s.KeepRecentTokens)
	data, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(data, '\n'), 0o600)
}

// setInt sets a positive number, or removes it.
func setInt(m map[string]any, key string, n int) {
	if n > 0 {
		m[key] = n
		return
	}
	delete(m, key)
}

// loadPiSettings reads the file into the app, for the settings page.
func (a *app) loadPiSettings() {
	s, err := readPiSettings()
	if err != nil {
		a.piSetErr = err.Error()
		return
	}
	a.piSet = s
	a.piSetErr = ""
	a.piRetryText.Set(modelNumber(s.RetryMax))
	a.piReserveText.Set(modelNumber(s.ReserveTokens))
	a.piKeepText.Set(modelNumber(s.KeepRecentTokens))
	a.piSetRev.Update(func(n int) int { return n + 1 })
}

// updatePiSettings changes one field and writes the file.
func (a *app) updatePiSettings(fn func(*piSettings)) {
	s := a.piSet
	fn(&s)
	if err := savePiSettings(s); err != nil {
		a.toast(ui.ToastError, "保存 pi 设置失败", err.Error())
		return
	}
	a.piSet = s
	a.piSetRev.Update(func(n int) int { return n + 1 })
}
