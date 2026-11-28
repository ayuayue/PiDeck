//go:build !js && !android && !ios

package workbench

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"go.yaml.in/yaml/v3"
)

func legacyChatFiles(ctx context.Context, source, chat string) ([]string, error) {
	// A custom chat folder outside Electron's data is already a user's
	// workspace. Keep it in place instead of recursively copying a project.
	if !pathWithin(source, chat) {
		return nil, nil
	}
	if _, err := os.Stat(chat); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	var files []string
	err := filepath.WalkDir(chat, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if entry.Type().IsRegular() {
			files = append(files, path)
		}
		return nil
	})
	return files, err
}

// copyLegacyChatFile never overwrites a destination or follows an existing
// directory link. The temporary file lives beside its final destination.
func copyLegacyChatFile(ctx context.Context, source, root, relative string) (bool, error) {
	if filepath.IsAbs(relative) || !pathWithin(root, filepath.Join(root, relative)) {
		return false, errors.New("chat destination escapes data directory")
	}
	parent := filepath.Dir(filepath.Join(root, relative))
	for current := parent; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err == nil && (info.Mode()&os.ModeSymlink != 0 || !info.IsDir()) {
			return false, errors.New("chat destination is not a regular directory")
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, err
		}
		if current == root {
			break
		}
		if next := filepath.Dir(current); next == current {
			return false, errors.New("invalid chat destination")
		}
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return false, err
	}
	destination := filepath.Join(root, relative)
	if _, err := os.Lstat(destination); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, errors.New("chat source is not a regular file")
	}
	in, err := os.Open(source)
	if err != nil {
		return false, err
	}
	defer in.Close()
	if opened, err := in.Stat(); err != nil || !os.SameFile(info, opened) {
		return false, errors.New("chat source changed during migration")
	}
	temp := filepath.Join(parent, ".pideck-migration-"+rand.Text()+".tmp")
	out, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return false, err
	}
	defer os.Remove(temp)
	_, copyErr := io.Copy(out, &migrationReader{ctx: ctx, reader: in})
	if err := errors.Join(copyErr, out.Close(), ctx.Err()); err != nil {
		return false, err
	}
	if _, err := os.Lstat(destination); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := os.Rename(temp, destination); err != nil {
		return false, err
	}
	return true, nil
}

type migrationReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *migrationReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func migrateLegacyTextSettings(source, destination string) error {
	var settings struct {
		Template string   `json:"enhanceSystemPrompt"`
		Quick    []string `json:"quickMessages"`
	}
	if err := readLegacyJSON(filepath.Join(source, "settings.json"), &settings); err != nil {
		return err
	}
	var firstErr error
	if strings.TrimSpace(settings.Template) != "" {
		path := filepath.Join(destination, promptTemplateFile)
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			if err := validatePromptTemplate(settings.Template); err != nil {
				firstErr = err
			} else {
				firstErr = writeFileAtomic(path, []byte(settings.Template), 0o600)
			}
		} else if err != nil {
			firstErr = err
		}
	}
	var quickRaw json.RawMessage
	if err := readLegacyJSON(filepath.Join(source, "quick-messages.json"), &quickRaw); err != nil {
		return errors.Join(firstErr, err)
	}
	if len(quickRaw) > 0 {
		if quickRaw[0] == '[' {
			if err := json.Unmarshal(quickRaw, &settings.Quick); err != nil {
				return errors.Join(firstErr, err)
			}
		} else {
			var envelope struct {
				Items []string `json:"items"`
			}
			if err := json.Unmarshal(quickRaw, &envelope); err != nil {
				return errors.Join(firstErr, err)
			}
			if envelope.Items == nil {
				return errors.Join(firstErr, fmt.Errorf("unrecognized quick-messages.json format"))
			}
			settings.Quick = envelope.Items
		}
	}
	if settings.Quick != nil {
		path := filepath.Join(destination, replyShortcutsFile)
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			data := defaultReplyShortcuts()
			data.QuickMessages = settings.Quick
			clean, err := prepareReplyShortcuts(data, true)
			if err != nil {
				return errors.Join(firstErr, err)
			}
			raw, err := yaml.Marshal(clean)
			if err == nil {
				err = writeFileAtomic(path, raw, 0o600)
			}
			return errors.Join(firstErr, err)
		} else if err != nil {
			return errors.Join(firstErr, err)
		}
	}
	return firstErr
}
