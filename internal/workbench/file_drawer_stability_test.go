//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestFileDrawerKeepsControlsAcrossBackgroundRefresh(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; native runs verify pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	t.Setenv("PIDECK_LITE_PI_CONFIG", t.TempDir())
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		a.files.watch(dir)
		return a.drawerFiles()
	}, nsgotest.Size(340, 700))
	screen.WaitFor("role:button note.txt", 5*time.Second)
	row := screen.Find("role:button note.txt").ID
	field := screen.Find("id:files-search").ID
	a.git.state.Set(gitState{IsRepo: true, Root: dir, Files: []gitFile{{Path: "note.txt", Y: 'M'}}})
	a.filesRev.Update(func(n int) int { return n + 1 })
	screen.Settle()
	if screen.Find("role:button note.txt").ID != row || screen.Find("id:files-search").ID != field {
		t.Fatal("background refresh remounted the file row or search input")
	}
	// Environment/plugin discovery reapplies the selected theme after
	// startup. An identical look must not replace interactive controls.
	a.applyTheme()
	screen.Settle()
	if screen.Find("role:button note.txt").ID != row || screen.Find("id:files-search").ID != field {
		t.Fatal("applying an unchanged theme remounted the file controls")
	}
	screen.Type("id:files-search", "note")
	screen.WaitFor("id:file-hit", 5*time.Second)
	a.filesRev.Update(func(n int) int { return n + 1 })
	a.git.state.Set(gitState{IsRepo: true, Root: dir})
	screen.Settle()
	if got := screen.Find("id:files-search"); got.ID != field || got.Text != "note" {
		t.Fatalf("background refresh replaced the active search: id=%v text=%q", got.ID, got.Text)
	}
}
