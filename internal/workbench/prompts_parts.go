//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Existing prompt pack files are the storage extension point. Keep each
// import comfortably within the settings archive's per-file budget.
const importedPromptPartLimit = 4 << 20

func writeImportedPromptParts(dir string, pack promptPack) error {
	for len(pack.Prompts) > 0 {
		size, count := 1024+len(pack.Name)*6, 0
		for _, entry := range pack.Prompts {
			raw, err := json.MarshalIndent(entry, "    ", "  ")
			if err != nil {
				return err
			}
			if size+len(raw)+8 > importedPromptPartLimit {
				break
			}
			size += len(raw) + 8
			count++
		}
		if count == 0 {
			return errors.New("prompt entry exceeds pack size limit")
		}
		raw, err := json.MarshalIndent(promptPack{Name: pack.Name, Prompts: pack.Prompts[:count]}, "", "  ")
		if err != nil {
			return err
		}
		raw = append(raw, '\n')
		if len(raw) > importedPromptPartLimit {
			return errors.New("prompt pack exceeds size limit")
		}
		sum := sha256.Sum256(raw)
		path := filepath.Join(dir, fmt.Sprintf("import-%x.json", sum[:12]))
		if old, err := os.ReadFile(path); err == nil {
			if !bytes.Equal(old, raw) {
				return errors.New("imported prompt file has external changes")
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		} else if err := writeFileAtomic(path, raw, 0o644); err != nil {
			return err
		}
		pack.Prompts = pack.Prompts[count:]
	}
	return nil
}
