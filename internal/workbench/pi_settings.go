//go:build !js && !android && !ios

package workbench

// pi's own settings.json, for the fields the app can show as controls.
// Everything else in the file is kept as it was.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/nsgo-dev/nsgo/ui"
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
	// Save requests wait for the previous one without blocking the UI.
	saveDone <-chan struct{}
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
	out := piSettings{RetryEnabled: true, CompactionEnabled: true}
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
		if enabled, ok := retry["enabled"].(bool); ok {
			out.RetryEnabled = enabled
		}
		out.RetryMax = intField(retry["maxRetries"])
	}
	if compaction, _ := root["compaction"].(map[string]any); compaction != nil {
		if enabled, ok := compaction["enabled"].(bool); ok {
			out.CompactionEnabled = enabled
		}
		out.ReserveTokens = intField(compaction["reserveTokens"])
		out.KeepRecentTokens = intField(compaction["keepRecentTokens"])
	}
	return out, nil
}

// savePiSettings merges only fields changed by this edit into the latest file.
func savePiSettings(before, s piSettings) error {
	piSettingsFileMu.Lock()
	defer piSettingsFileMu.Unlock()
	path := piSettingsPath()
	if path == "" {
		return fmt.Errorf("找不到 pi 的配置目录")
	}
	root := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(raw, &root); err != nil {
			return fmt.Errorf("settings.json 不是有效的 JSON：%w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if root == nil {
		root = map[string]any{}
	}
	if s.HideThinking != before.HideThinking {
		root["hideThinkingBlock"] = s.HideThinking
	}
	if s.QuietStartup != before.QuietStartup {
		root["quietStartup"] = s.QuietStartup
	}
	if s.CollapseChangelog != before.CollapseChangelog {
		root["collapseChangelog"] = s.CollapseChangelog
	}
	if s.DefaultThinking != before.DefaultThinking {
		if s.DefaultThinking == "" {
			delete(root, "defaultThinkingLevel")
		} else {
			root["defaultThinkingLevel"] = s.DefaultThinking
		}
	}
	if s.RetryEnabled != before.RetryEnabled || s.RetryMax != before.RetryMax {
		retry, _ := root["retry"].(map[string]any)
		if retry == nil {
			retry = map[string]any{}
		}
		if s.RetryEnabled != before.RetryEnabled {
			retry["enabled"] = s.RetryEnabled
		}
		if s.RetryMax != before.RetryMax {
			setInt(retry, "maxRetries", s.RetryMax)
		}
		root["retry"] = retry
	}
	if s.CompactionEnabled != before.CompactionEnabled || s.ReserveTokens != before.ReserveTokens || s.KeepRecentTokens != before.KeepRecentTokens {
		compaction, _ := root["compaction"].(map[string]any)
		if compaction == nil {
			compaction = map[string]any{}
		}
		if s.CompactionEnabled != before.CompactionEnabled {
			compaction["enabled"] = s.CompactionEnabled
		}
		if s.ReserveTokens != before.ReserveTokens {
			setInt(compaction, "reserveTokens", s.ReserveTokens)
		}
		if s.KeepRecentTokens != before.KeepRecentTokens {
			setInt(compaction, "keepRecentTokens", s.KeepRecentTokens)
		}
		root["compaction"] = compaction
	}
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

// updatePiSettings changes one field and saves edits in order off the UI thread.
func (a *app) updatePiSettings(fn func(*piSettings)) {
	before := a.piSet
	s := before
	fn(&s)
	if s == before {
		return
	}
	done := make(chan struct{})
	s.saveDone = done
	a.piSet, a.piSetErr = s, ""
	a.piSetRev.Update(func(n int) int { return n + 1 })
	configWrites.Add(1)
	go func() {
		defer configWrites.Done()
		defer close(done)
		if before.saveDone != nil {
			<-before.saveDone
		}
		err := savePiSettings(before, s)
		a.cx.Post(func() {
			if a.piSet.saveDone == done {
				if err != nil {
					a.piSetErr = err.Error()
				} else {
					a.piSet.Loaded = true
				}
				a.piSetRev.Update(func(n int) int { return n + 1 })
			}
			if err != nil {
				a.toast(ui.ToastError, "保存 pi 设置失败", err.Error())
			}
		})
	}()
}
