//go:build !js && !android && !ios

package workbench

// Checks for the file tree's Git status marks.

import (
	"path/filepath"
	"testing"
)

// TestChangedDirs checks every folder above a changed file is marked,
// up to the workspace root.
func TestChangedDirs(t *testing.T) {
	root := filepath.Clean(`C:\work\shop`)
	marks := map[string]gitFile{
		filepath.Join(root, "src", "app.go"):     {Path: "src/app.go"},
		filepath.Join(root, "README.md"):         {Path: "README.md"},
		filepath.Join(root, "docs", "a", "b.md"): {Path: "docs/a/b.md"},
	}
	dirs := changedDirs(marks, root)
	for _, want := range []string{root, filepath.Join(root, "src"), filepath.Join(root, "docs"), filepath.Join(root, "docs", "a")} {
		if !dirs[want] {
			t.Errorf("folder %q is not marked", want)
		}
	}
	if dirs[filepath.Join(root, "other")] {
		t.Error("an unchanged folder is marked")
	}
}

// TestGitMarkColor checks the tones each letter gets.
func TestGitMarkColor(t *testing.T) {
	cases := map[string]string{"A": "up", "D": "down", "U": "down", "M": "warn", "R": "warn", "?": "faint"}
	for mark, want := range cases {
		if got := gitMarkColor(mark); got != want {
			t.Errorf("gitMarkColor(%q) = %q, want %q", mark, got, want)
		}
	}
}
