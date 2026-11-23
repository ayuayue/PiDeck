//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"example.com/pideck-v2/internal/apptext"
	"go.yaml.in/yaml/v3"
)

const (
	memoryFile       = "memory.yaml"
	memoryMaxBytes   = 4 << 20
	memoryMaxEntries = 500
)

type memoryEntry struct {
	ID      string    `json:"id" yaml:"id"`
	Project string    `json:"-" yaml:"project,omitempty"`
	Title   string    `json:"title" yaml:"title"`
	Body    string    `json:"body" yaml:"markdown"`
	Updated time.Time `json:"updated" yaml:"updated"`
}

func (e memoryEntry) valid() bool {
	return e.ID != "" && len(e.ID) <= 128 && len(e.Project) <= 2048 && strings.TrimSpace(e.Title) != "" &&
		utf8.RuneCountInString(e.Title) <= 100 && strings.TrimSpace(e.Body) != "" && len(e.Body) <= 24<<10
}

type memoryBundle struct {
	Version int           `yaml:"version"`
	Entries []memoryEntry `yaml:"entries"`
}

type memoryStore struct {
	file    string
	mu      sync.RWMutex
	writeMu sync.Mutex
	entries []memoryEntry
}

func readMemoryBundle(file string) ([]memoryEntry, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, memoryMaxBytes+1))
	if err != nil {
		return nil, err
	}
	var bundle memoryBundle
	if len(raw) > memoryMaxBytes || yaml.Unmarshal(raw, &bundle) != nil || bundle.Version != 1 || len(bundle.Entries) > memoryMaxEntries {
		return nil, errors.New(apptext.T("记忆文件格式无效或超过大小限制。"))
	}
	seen := make(map[string]bool, len(bundle.Entries))
	for _, entry := range bundle.Entries {
		if !entry.valid() || seen[entry.ID] {
			return nil, errors.New(apptext.T("记忆文件格式无效或超过大小限制。"))
		}
		seen[entry.ID] = true
	}
	return bundle.Entries, nil
}

func writeMemoryBundle(file string, entries []memoryEntry) error {
	raw, err := yaml.Marshal(memoryBundle{Version: 1, Entries: entries})
	if err != nil {
		return err
	}
	if len(entries) > memoryMaxEntries || len(raw) > memoryMaxBytes {
		return errors.New(apptext.T("记忆库已满，请清理后再保存。"))
	}
	return writeFileAtomic(file, raw, 0o600)
}

func newMemoryStore(dir string) *memoryStore {
	m := &memoryStore{file: filepath.Join(dir, memoryFile)}
	m.entries, _ = readMemoryBundle(m.file)
	return m
}

func (m *memoryStore) snapshot() []memoryEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return slices.Clone(m.entries)
}

func (m *memoryStore) change(update func([]memoryEntry) ([]memoryEntry, error)) error {
	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	next, err := update(m.snapshot())
	if err != nil {
		return err
	}
	if err := writeMemoryBundle(m.file, next); err != nil {
		return err
	}
	m.mu.Lock()
	m.entries = next
	m.mu.Unlock()
	return nil
}

func (m *memoryStore) put(e memoryEntry) (memoryEntry, error) {
	e.Title, e.Body = strings.TrimSpace(e.Title), strings.TrimSpace(e.Body)
	if e.ID == "" {
		e.ID = newSessionID()
	}
	if !e.valid() {
		return memoryEntry{}, errors.New(apptext.T("请填写记忆标题和正文。"))
	}
	err := m.change(func(list []memoryEntry) ([]memoryEntry, error) {
		i := slices.IndexFunc(list, func(item memoryEntry) bool { return item.ID == e.ID })
		if i >= 0 {
			if list[i].Project != e.Project || !list[i].Updated.Equal(e.Updated) {
				return nil, errors.New(apptext.T("记忆已更新，请重新打开后再保存。"))
			}
			list = slices.Delete(list, i, i+1)
		} else if !e.Updated.IsZero() {
			return nil, errors.New(apptext.T("记忆已更新，请重新打开后再保存。"))
		}
		now := time.Now().UTC()
		if !now.After(e.Updated) {
			now = e.Updated.Add(time.Nanosecond)
		}
		e.Updated = now
		return append([]memoryEntry{e}, list...), nil
	})
	return e, err
}

func (m *memoryStore) merge(entries []memoryEntry) (int, error) {
	var added int
	err := m.change(func(list []memoryEntry) ([]memoryEntry, error) {
		seen := make(map[string]bool, len(list))
		for _, e := range list {
			seen[e.ID] = true
		}
		for _, e := range entries {
			if !seen[e.ID] {
				list = append(list, e)
				seen[e.ID] = true
				added++
			}
		}
		return list, nil
	})
	return added, err
}
