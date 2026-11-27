//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestFileSortKeepsDirectoriesFirstAndInputUnchanged(t *testing.T) {
	entries := []fileEntry{
		{Name: "z.go", Path: "z.go", Modified: time.Unix(20, 0), Size: 2, Known: true},
		{Name: "b.txt", Path: "b.txt", Modified: time.Unix(10, 0), Size: 8, Known: true},
		{Name: "dir", Path: "dir", Dir: true, Known: true},
		{Name: "a.go", Path: "a.go", Modified: time.Unix(10, 0), Size: 4, Known: true},
		{Name: "missing", Path: "missing"},
		{Name: "…", Path: "."},
	}
	original := append([]fileEntry(nil), entries...)
	for _, tc := range []struct {
		order fileSort
		want  []string
	}{
		{fileSortName, []string{"dir", "a.go", "b.txt", "missing", "z.go", "…"}},
		{fileSortNameDesc, []string{"dir", "z.go", "missing", "b.txt", "a.go", "…"}},
		{fileSortModified, []string{"dir", "z.go", "a.go", "b.txt", "missing", "…"}},
		{fileSortOldest, []string{"dir", "a.go", "b.txt", "z.go", "missing", "…"}},
		{fileSortType, []string{"dir", "missing", "a.go", "z.go", "b.txt", "…"}},
		{fileSortTypeDesc, []string{"dir", "b.txt", "z.go", "a.go", "missing", "…"}},
		{fileSortSize, []string{"dir", "b.txt", "a.go", "z.go", "missing", "…"}},
		{fileSortSmallest, []string{"dir", "z.go", "a.go", "b.txt", "missing", "…"}},
	} {
		t.Run(string(tc.order), func(t *testing.T) {
			var got []string
			for _, entry := range sortedFileEntries(entries, tc.order) {
				got = append(got, entry.Name)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
	if !reflect.DeepEqual(entries, original) {
		t.Fatal("sort mutated its shared input")
	}
	if fileExtension(".gitignore") != "" || fileExtension("PHOTO.PNG") != ".png" {
		t.Fatal("extension normalization failed")
	}
}

func TestFileSortReadsRealMetadataAndToleratesMissingFiles(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "note.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	modified := time.Unix(1700000000, 0)
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	entries := readFileSortEntries(root, []string{"note.txt", "deleted.txt"})
	if got := entries["note.txt"]; !got.Known || got.Size != 5 || !got.Modified.Equal(modified) {
		t.Fatalf("wrong metadata: %+v", got)
	}
	if entries["deleted.txt"].Known {
		t.Fatal("missing file had fabricated metadata")
	}
}

func TestFileDrawerSortPreservesControlsAndFolderExpansion(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless interaction test")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"a.txt": "long content", "z.go": "go", "src/child.go": "package src"} {
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(name)), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		a.files.watch(root)
		return a.drawerFiles()
	}, nsgotest.Size(400, 760), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	screen.WaitFor("role:button z.go", 5*time.Second)
	field := screen.Find("id:files-search").ID
	row := screen.Find("role:button z.go").ID
	if !screen.Enabled("id:files-open-folder") {
		t.Fatal("file manager action is disabled for a local project")
	}
	screen.Press("role:button src")
	screen.WaitFor("role:button child.go", 5*time.Second)
	screen.Press("id:files-sort")
	screen.Key("end")
	screen.Key("enter")
	screen.Settle()
	if got := a.files.order.Get(); got != fileSortSmallest {
		t.Fatalf("sort menu selected %q, want smallest", got)
	}
	if screen.Find("id:files-search").ID != field || screen.Find("role:button z.go").ID != row {
		t.Fatal("sort remounted persistent controls")
	}
	if !a.files.expanded[filepath.Join(root, "src")] {
		t.Fatal("sort collapsed an open directory")
	}
	screen.Type("id:files-search", ".")
	screen.WaitFor("id:file-hit >> nth=0", 5*time.Second)
	screen.Post(func() { a.files.setOrder(fileSortSize) })
	screen.Settle()
	if got := screen.Find("id:files-search"); got.ID != field || got.Text != "." {
		t.Fatal("sort discarded active search")
	}
	screen.Press("id:files-scope-session")
	if a.files.order.Get() != fileSortSize {
		t.Fatal("scope switch discarded sort")
	}
	screen.Press("id:files-scope-all")
	screen.WaitFor("id:file-hit >> nth=0", 5*time.Second)
}
