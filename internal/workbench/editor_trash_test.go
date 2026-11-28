//go:build !js && !android && !ios

package workbench

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMoveToTrashProtectsPendingSave(t *testing.T) {
	for _, kind := range []string{"file", "parent-directory", "unrelated-prefix"} {
		t.Run(kind, func(t *testing.T) {
			h, nextResult := editorIOTestHost(t)
			a := &app{editor: h, st: &store{dir: t.TempDir()}}
			root := t.TempDir()
			dir := filepath.Join(root, "docs")
			busyDir := dir
			if kind == "unrelated-prefix" {
				busyDir += "-other"
			}
			for _, path := range []string{dir, busyDir} {
				if err := os.MkdirAll(path, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			path := filepath.Join(busyDir, "note.txt")
			if err := os.WriteFile(path, []byte("before save"), 0o600); err != nil {
				t.Fatal(err)
			}
			h.openFile(root, path)
			nextResult()()
			f := h.activeFile()
			f.Text.Set("latest saved text")
			f.Dirty.Set(true)
			from := dir
			if kind == "file" {
				from = path
			}
			// Hold the real save before it reaches disk, then request trash.
			key := strings.ToLower(f.file.target.key() + "|" + f.file.root + "|" + f.file.rel)
			lock := &workspaceFileLocks[sha256.Sum256([]byte(key))[0]%byte(len(workspaceFileLocks))]
			lock.Lock()
			locked := true
			defer func() {
				if locked {
					lock.Unlock()
				}
			}()
			h.save(f)
			dest, moveErr := a.moveToTrash(from)
			locked = false
			lock.Unlock()
			nextResult()()

			if kind == "unrelated-prefix" {
				if moveErr != nil || dest == "" {
					t.Fatalf("unrelated directory was blocked by pending save: %q, %v", dest, moveErr)
				}
			} else {
				if moveErr == nil || dest != "" {
					t.Fatalf("trash moved a file with a pending save: destination=%q, dirty=%v", dest, f.Dirty.GetUntracked())
				}
				if _, err := os.Stat(filepath.Join(a.st.dir, "trash")); !os.IsNotExist(err) {
					t.Fatalf("refused move created trash artifacts: %v", err)
				}
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != "latest saved text" || f.Dirty.GetUntracked() || f.busy.GetUntracked() {
				t.Fatalf("save after trash request: disk=%q error=%v dirty=%v busy=%v",
					data, err, f.Dirty.GetUntracked(), f.busy.GetUntracked())
			}
			if kind == "unrelated-prefix" {
				return
			}
			// Retrying after the save must archive the newly saved bytes.
			dest, err = a.moveToTrash(from)
			if err != nil {
				t.Fatal(err)
			}
			archived := dest
			if kind == "parent-directory" {
				archived = filepath.Join(dest, "note.txt")
			}
			data, err = os.ReadFile(archived)
			if err != nil || string(data) != "latest saved text" {
				t.Fatalf("archived file = %q, %v; want the completed save", data, err)
			}
			if _, err := os.Stat(from); !os.IsNotExist(err) {
				t.Fatalf("trash left the original path: %v", err)
			}
		})
	}
}
