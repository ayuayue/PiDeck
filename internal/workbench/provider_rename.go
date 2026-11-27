//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type providerRenameFile struct {
	path          string
	before, after []byte
	root          map[string]any
	exists        bool
}

// renameProviderConfig preserves complete entries, including unknown credentials.
// Lock order is models -> usage -> auth -> pi settings; no callback reacquires them.
// Individual replacements are atomic; cross-file rollback is only best effort.
func renameProviderConfig(from, to string) error {
	if !validProviderID(from) || !validProviderID(to) {
		return errors.New("invalid provider ID")
	}
	if from == to {
		return errors.New("provider IDs must differ")
	}
	modelsFileMu.Lock()
	defer modelsFileMu.Unlock()
	usageProbeConfigMu.Lock()
	defer usageProbeConfigMu.Unlock()
	if modelsJSONPath() == "" {
		return errors.New("pi configuration directory is unavailable")
	}
	return withAuthWrite(func() error {
		piSettingsFileMu.Lock()
		defer piSettingsFileMu.Unlock()
		paths := []string{modelsJSONPath(), authPath(), usageProbeConfigPath(), piSettingsPath()}
		files := make([]providerRenameFile, len(paths))
		for i, path := range paths {
			file, err := readProviderRenameFile(path, i != 0)
			if err != nil {
				return err
			}
			files[i] = file
		}
		for i := range files {
			file := &files[i]
			if !file.exists {
				continue
			}
			changed := false
			var err error
			switch i {
			case 0, 2:
				entries, exists := file.root["providers"]
				if !exists && i == 2 {
					break
				}
				providers, ok := entries.(map[string]any)
				if !ok || providers == nil {
					return fmt.Errorf("%s: providers must be an object", filepath.Base(file.path))
				}
				if i == 0 {
					if _, err := providerDocument(providers, from); err != nil {
						return err
					}
					for id := range providers {
						if _, err := providerDocument(providers, id); err != nil {
							return err
						}
					}
				}
				changed, err = moveProviderRenameEntry(providers, from, to)
			case 1:
				changed, err = moveProviderRenameEntry(file.root, from, to)
			case 3:
				changed, err = renameProviderPiSettings(file.root, from, to)
			}
			if err != nil {
				return fmt.Errorf("%s: %w", filepath.Base(file.path), err)
			}
			if changed {
				data, err := json.MarshalIndent(file.root, "", "  ")
				if err != nil {
					return fmt.Errorf("%s: cannot encode configuration", filepath.Base(file.path))
				}
				file.after = append(data, '\n')
			}
		}
		return writeProviderRenameFiles(files, writeFileAtomic)
	})
}

func readProviderRenameFile(path string, optional bool) (providerRenameFile, error) {
	file := providerRenameFile{path: path}
	// Atomic replacement must follow an existing symlink, as auth writes do.
	if real, err := filepath.EvalSymlinks(path); err == nil {
		file.path = real
	}
	data, err := os.ReadFile(file.path)
	if optional && errors.Is(err, os.ErrNotExist) {
		return file, nil
	}
	if err != nil {
		return file, fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}
	value, err := usageProbeDecodeJSON(data)
	root, ok := value.(map[string]any)
	if err != nil || !ok || root == nil {
		// Decoder diagnostics can contain input; never include credential bytes.
		return file, fmt.Errorf("%s: expected a valid JSON object without duplicate keys", filepath.Base(path))
	}
	file.before, file.root, file.exists = data, root, true
	return file, nil
}

func moveProviderRenameEntry(entries map[string]any, from, to string) (bool, error) {
	for _, entry := range entries {
		if object, ok := entry.(map[string]any); !ok || object == nil {
			return false, errors.New("provider entries must be objects")
		}
	}
	if _, exists := entries[to]; exists {
		return false, errProviderExists
	}
	entry, exists := entries[from]
	if exists {
		entries[to] = entry
		delete(entries, from)
	}
	return exists, nil
}

func renameProviderPiSettings(root map[string]any, from, to string) (bool, error) {
	changed := false
	if raw, exists := root["defaultProvider"]; exists {
		provider, ok := raw.(string)
		if !ok {
			return false, errors.New("defaultProvider must be a string")
		}
		if provider == from {
			root["defaultProvider"], changed = to, true
		}
	}
	if raw, exists := root["modelThinkingLevels"]; exists {
		levels, ok := raw.(map[string]any)
		if !ok || levels == nil {
			return false, errors.New("modelThinkingLevels must be an object")
		}
		for key, value := range levels {
			if _, ok := value.(string); !ok {
				return false, errors.New("modelThinkingLevels values must be strings")
			}
			if !strings.HasPrefix(key, from+"/") {
				continue
			}
			target := to + strings.TrimPrefix(key, from)
			if _, exists := levels[target]; exists {
				return false, errProviderExists
			}
			levels[target] = value
			delete(levels, key)
			changed = true
		}
	}
	return changed, nil
}

func checkProviderRenameBytes(file providerRenameFile, expected []byte) error {
	current, err := os.ReadFile(file.path)
	if !file.exists && errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("check %s: %w", filepath.Base(file.path), err)
	}
	if !file.exists || !bytes.Equal(current, expected) {
		return fmt.Errorf("%s: configuration changed externally", filepath.Base(file.path))
	}
	return nil
}

// The writer argument permits deterministic failure coverage without global hooks.
func writeProviderRenameFiles(files []providerRenameFile, write func(string, []byte, os.FileMode) error) error {
	// Include absent and unchanged optional files in the initial stale-read check.
	for _, file := range files {
		if err := checkProviderRenameBytes(file, file.before); err != nil {
			return err
		}
	}
	var written []providerRenameFile
	rollback := func(cause error) error {
		result := fmt.Errorf("provider rename failed (rollback attempted): %w", cause)
		for i := len(written) - 1; i >= 0; i-- {
			file := written[i]
			err := checkProviderRenameBytes(file, file.after)
			if err == nil {
				err = write(file.path, file.before, 0o600)
			}
			if err != nil {
				result = errors.Join(result, fmt.Errorf("rollback %s failed: %w", filepath.Base(file.path), err))
			}
		}
		return result
	}
	for _, file := range files {
		if file.after == nil {
			continue
		}
		if err := checkProviderRenameBytes(file, file.before); err != nil {
			return rollback(err)
		}
		if err := write(file.path, file.after, 0o600); err != nil {
			return rollback(fmt.Errorf("write %s: %w", filepath.Base(file.path), err))
		}
		written = append(written, file)
	}
	return nil
}
