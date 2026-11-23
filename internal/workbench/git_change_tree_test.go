//go:build !js && !android && !ios

package workbench

// Checks the changes tree: folders first with their file counts, a folded
// folder hiding what it holds, and one row per path at the top level.

import (
	"reflect"
	"testing"
)

func TestGitChangeTree(t *testing.T) {
	files := []gitFile{
		{Path: "internal/workbench/b.go", X: 'M'},
		{Path: "internal/workbench/a.go", X: 'M'},
		{Path: "internal/apptext/c.json", X: 'M'},
		{Path: "README.md", X: 'M'},
	}
	rows := gitChangeTree(files, nil)
	var got []string
	for _, row := range rows {
		name := row.Name
		if row.Dir {
			name = row.Path + "/"
		}
		got = append(got, name)
		if row.Dir && row.Count == 0 {
			t.Errorf("folder %q counted no files", row.Path)
		}
	}
	want := []string{
		"internal/", "internal/apptext/", "c.json",
		"internal/workbench/", "a.go", "b.go",
		"README.md",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tree rows = %v, want %v", got, want)
	}
	// Depth indents the rows, so a nested file sits under its folder.
	for _, row := range rows {
		if row.Path == "internal/workbench/a.go" && row.Depth != 2 {
			t.Errorf("depth of %s = %d, want 2", row.Path, row.Depth)
		}
		if row.Path == "internal" && row.Count != 3 {
			t.Errorf("internal counts %d files, want 3", row.Count)
		}
	}

	// A folded folder is one row: its files are left out.
	folded := gitChangeTree(files, map[string]bool{"internal/workbench": true})
	got = got[:0]
	for _, row := range folded {
		got = append(got, row.Name)
	}
	want = []string{"internal", "apptext", "c.json", "workbench", "README.md"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("folded rows = %v, want %v", got, want)
	}
}

// TestGitChangeTreeTopLevel checks a repository whose changes are all in
// the root: the tree is the list, with no folders to fold.
func TestGitChangeTreeTopLevel(t *testing.T) {
	rows := gitChangeTree([]gitFile{{Path: "b.txt"}, {Path: "a.txt"}}, nil)
	if len(rows) != 2 || rows[0].Name != "a.txt" || rows[1].Name != "b.txt" {
		t.Fatalf("rows = %+v, want a.txt then b.txt", rows)
	}
	for _, row := range rows {
		if row.Dir {
			t.Fatalf("%q became a folder", row.Name)
		}
	}
}

// TestGitChangeTreeFoldsFolderChains checks a chain of one-child folders
// takes one row, and that folding it hides the file under it.
func TestGitChangeTreeFoldsFolderChains(t *testing.T) {
	files := []gitFile{{Path: "src/app/lib/main.ts"}, {Path: "src/app/lib/util.ts"}}
	rows := gitChangeTree(files, nil)
	if len(rows) != 3 || !rows[0].Dir || rows[0].Name != "src/app/lib" {
		t.Fatalf("rows = %+v, want one src/app/lib row and two files", rows)
	}
	if rows[0].Path != "src/app/lib" || rows[0].Count != 2 {
		t.Fatalf("folder = %+v, want path src/app/lib with 2 files", rows[0])
	}
	folded := gitChangeTree(files, map[string]bool{"src/app/lib": true})
	if len(folded) != 1 || folded[0].Name != "src/app/lib" {
		t.Fatalf("folded rows = %+v, want just the folder", folded)
	}
}
