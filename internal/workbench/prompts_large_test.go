//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestLargePromptImportFitsSettingsBackup(t *testing.T) {
	a := &app{st: &store{dir: t.TempDir()}}
	pack := promptPack{Name: "Large library"}
	for i := range 240 {
		pack.Prompts = append(pack.Prompts, promptPackEntry{Title: fmt.Sprintf("Prompt %d", i), Body: strings.Repeat("x", 50<<10)})
	}
	if n, _, err := a.importPromptPack(pack); err != nil || n != len(pack.Prompts) {
		t.Fatalf("imported=%d err=%v", n, err)
	}
	if _, err := a.settingsZip(); err != nil {
		t.Fatalf("valid imported library broke backup: %v", err)
	}
	if n, skipped, err := a.importPromptPack(pack); err != nil || n != 0 || skipped != len(pack.Prompts) {
		t.Fatalf("duplicate import=%d/%d %v", n, skipped, err)
	}
	if got := len(a.loadPrompts()); got != len(pack.Prompts) {
		t.Fatalf("loaded=%d want=%d", got, len(pack.Prompts))
	}
	files, err := os.ReadDir(a.promptsDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		info, err := os.Stat(filepath.Join(a.promptsDir(), file.Name()))
		if err != nil || info.Size() > backupFileLimit {
			t.Fatalf("oversized pack %s: %v", file.Name(), err)
		}
	}
}

func TestPromptLibraryLoadsInBackground(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; native runs verify pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	if err := os.MkdirAll(filepath.Join(home, "prompts"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "prompts", "user.json"), []byte(`{"prompts":[{"title":"Async library fixture","body":"Actual imported text"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node { a = newApp(cx); return a.promptDialog() }, nsgotest.Size(1100, 760))
	a.openPromptLibrary()
	if !a.promptOpen.GetUntracked() || !a.promptLoading.GetUntracked() {
		t.Fatal("library did not open while its disk read was pending")
	}
	screen.WaitFor("text:Async library fixture", 5*time.Second)
	screen.WaitUntil(5*time.Second, func() bool { return !a.promptLoading.GetUntracked() })
	screen.Type("id:prompt-search", "Async")
	screen.WaitFor("text:Async library fixture", 5*time.Second)
}
