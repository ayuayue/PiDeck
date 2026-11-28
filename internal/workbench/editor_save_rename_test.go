//go:build !js && !android && !ios

package workbench

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func TestFileRenameProtectsPendingSave(t *testing.T) {
	for _, kind := range []string{"file", "parent-directory", "unrelated-prefix"} {
		t.Run(kind, func(t *testing.T) {
			h, nextResult := editorIOTestHost(t)
			cx := h.cx
			a := &app{
				cx: cx, editor: h, files: newFileTree(cx), toaster: ui.NewToaster(cx),
				fileOpTitle: core.NewSignal(cx, ""), fileOpText: core.NewSignal(cx, ""),
				fileOpOpen: core.NewSignal(cx, false),
			}
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
			old := filepath.Join(busyDir, "note.txt")
			if err := os.WriteFile(old, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			h.openFile(root, old)
			nextResult()()
			f := h.activeFile()
			f.Text.Set("unsaved text")
			f.Dirty.Set(true)
			from, to := dir, filepath.Join(root, "renamed-docs")
			if kind == "file" {
				from, to = old, filepath.Join(busyDir, "renamed.txt")
			}
			// Start saving after the name dialog opens: the check must run
			// when the rename is confirmed, not only when opening the dialog.
			a.renameFileNode(from)
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
			if !f.busy.GetUntracked() {
				t.Fatal("save did not start")
			}
			a.fileOpText.Set(filepath.Base(to))
			a.confirmFileName()
			_, fromErr := os.Stat(from)
			moved := os.IsNotExist(fromErr)
			// A recreated empty old path matches the captured revision. An
			// in-flight save must not write it while marking the new path saved.
			if _, err := os.Stat(old); os.IsNotExist(err) {
				if err := os.MkdirAll(filepath.Dir(old), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(old, nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			locked = false
			lock.Unlock()
			// A refusal also posts the toast's lifecycle before the worker
			// result. The manual clock keeps this bounded to those two posts.
			for i := 0; f.busy.GetUntracked() && i < 2; i++ {
				nextResult()()
			}
			data, err := os.ReadFile(f.Path)
			if f.busy.GetUntracked() || f.Dirty.GetUntracked() || err != nil || string(data) != "unsaved text" {
				t.Fatalf("pending save left the tab inconsistent with disk: text=%q disk=%q error=%v dirty=%v busy=%v",
					f.Text.GetUntracked(), data, err, f.Dirty.GetUntracked(), f.busy.GetUntracked())
			}
			if kind == "unrelated-prefix" {
				if !moved || f.Path != old {
					t.Fatal("an unrelated saving file prevented rename or changed its own path")
				}
				return
			}
			if moved || f.Path != old {
				t.Fatal("rename moved a file with a pending save")
			}
			// Retrying once the save finishes must still rename normally.
			a.renameFileNode(from)
			a.fileOpText.Set(filepath.Base(to))
			a.confirmFileName()
			data, err = os.ReadFile(f.Path)
			if f.Path == old || err != nil || string(data) != "unsaved text" || f.Dirty.GetUntracked() {
				t.Fatalf("rename after save = %q, %q, %v, dirty=%v", f.Path, data, err, f.Dirty.GetUntracked())
			}
		})
	}
}
