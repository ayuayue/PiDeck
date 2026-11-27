//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

type modelOptionsState struct {
	items    []modelOption
	stamp    string
	checked  time.Time
	busy     bool
	dirty    bool
	revision uint64
	retries  int
	announce bool
	err      string
}

func (a *app) modelOptionsFor(dir string) *modelOptionsState {
	if a.modelOptions == nil {
		a.modelOptions = make(map[string]*modelOptionsState)
	}
	if a.modelOptions[dir] == nil {
		a.modelOptions[dir] = &modelOptionsState{dirty: true}
	}
	return a.modelOptions[dir]
}

// invalidateModelOptions is called after pi/config/credentials have changed,
// including the initial environment probe. Only the active project is eagerly
// read; other projects retain their last good projection until next opened.
func (a *app) invalidateModelOptions(piPath string) {
	for _, entry := range a.modelOptions {
		entry.dirty = true
		entry.revision++
		entry.retries = 0
	}
	if piPath == "" {
		return
	}
	dir := loginDir()
	if ws := a.activeWorkspace(); ws != nil && !ws.Target.remote() {
		dir = ws.Path
	}
	a.requestModelOptions(dir, false, false)
}

func (a *app) ensureSessionModelOptions(s *session, force, announce bool) {
	if s == nil || s.backend == "acp" || s.Target.remote() {
		return
	}
	entry := a.modelOptionsFor(s.WS)
	a.publishSessionModelOptions(s, entry)
	a.requestModelOptions(s.WS, force, announce)
}

func (a *app) requestModelOptions(dir string, force, announce bool) {
	if a.st == nil || a.env == nil {
		return
	}
	info := a.env.GetUntracked()
	if info.PiPath == "" || info.PiError != "" {
		return
	}
	entry := a.modelOptionsFor(dir)
	entry.announce = entry.announce || announce
	if force {
		entry.dirty = true
		entry.revision++
		entry.retries = 0
	}
	if entry.busy {
		return
	}
	entry.busy = true
	revision, dirty := entry.revision, entry.dirty
	stamp, checked, previousError := entry.stamp, entry.checked, entry.err
	now := a.cx.Now()
	sessions, dataDir, configDir := a.st.sessions, a.dataDir, piConfigDir()
	a.publishModelOptions(dir, entry)
	go func() {
		current, err := modelOptionsStamp(configDir, dir)
		reused := err == nil && !dirty && previousError == "" && current == stamp && now.Sub(checked) < 5*time.Minute
		var items []modelOption
		if err == nil && !reused {
			ctx, cancel := context.WithTimeout(a.lifetime, 50*time.Second)
			items, err = probeModelOptions(ctx, info.PiPath, dir, sessions, dataDir)
			cancel()
			if err == nil {
				var after string
				after, err = modelOptionsStamp(configDir, dir)
				if err == nil && current != after {
					err = errors.New("pi model configuration changed during refresh")
				}
			}
		}
		a.cx.Post(func() {
			entry.busy = false
			if entry.revision != revision {
				a.requestModelOptions(dir, false, false)
				return
			}
			announce := entry.announce
			entry.announce = false
			if err == nil {
				if !reused {
					entry.items, entry.stamp, entry.checked = items, current, a.cx.Now()
				}
				entry.err, entry.dirty, entry.retries = "", false, 0
			} else {
				entry.err = err.Error()
			}
			a.publishModelOptions(dir, entry)
			if announce {
				if err != nil {
					a.toast(ui.ToastError, "刷新模型失败", err.Error())
				} else {
					a.toast(ui.ToastSuccess, "模型列表已刷新", fmt.Sprintf("共 %d 个模型。", len(entry.items)))
				}
			}
			if err != nil && entry.checked.IsZero() && entry.retries < 2 {
				entry.retries++
				a.cx.AfterFunc(time.Duration(entry.retries)*2*time.Second, func() {
					if entry.revision == revision && entry.err != "" && !entry.busy {
						a.requestModelOptions(dir, false, false)
					}
				})
			}
		})
	}()
}

func (a *app) publishModelOptions(dir string, entry *modelOptionsState) {
	for _, s := range a.all {
		if s.WS == dir && s.backend != "acp" && !s.Target.remote() && !s.deleting {
			a.publishSessionModelOptions(s, entry)
		}
	}
}

func (a *app) publishSessionModelOptions(s *session, entry *modelOptionsState) {
	s.modelsBusy.Set(entry.busy)
	if !entry.checked.IsZero() {
		models := make([]modelInfo, 0, len(entry.items))
		for _, option := range entry.items {
			models = append(models, option.modelInfo)
		}
		s.models.Set(models)
		if s.engine == nil || s.starting {
			a.seedModelThinking(s, entry.items)
		}
	}
}

func (a *app) seedModelThinking(s *session, options []modelOption) {
	chosen := s.model.GetUntracked()
	for _, option := range options {
		if option.ID != chosen.ID || option.Provider != chosen.Provider {
			continue
		}
		s.model.Set(option.modelInfo)
		s.levels.Set(slices.Clone(option.Levels))
		if level := option.Clamped[s.thinking.GetUntracked()]; level != "" {
			s.thinking.Set(level)
		}
		return
	}
}

// The file stamp is checked off-thread on every picker open. No watcher or
// permanent child process is needed, and external model/auth edits are seen
// without restarting a conversation. Extension updates also expire by age.
func modelOptionsStamp(configDir, dir string) (string, error) {
	paths := []string{
		filepath.Join(configDir, "models.json"), filepath.Join(configDir, "auth.json"),
		filepath.Join(configDir, "models-store.json"), filepath.Join(configDir, "settings.json"),
		filepath.Join(configDir, "extensions"), filepath.Join(dir, ".pi", "settings.json"),
		filepath.Join(dir, ".pi", "extensions"),
	}
	stamp := ""
	for _, path := range paths {
		info, err := os.Stat(path)
		if errors.Is(err, os.ErrNotExist) {
			stamp += "missing;"
			continue
		}
		if err != nil {
			return "", fmt.Errorf("read pi model configuration: %w", err)
		}
		stamp += fmt.Sprintf("%d/%d;", info.Size(), info.ModTime().UnixNano())
	}
	return stamp, nil
}
