//go:build !js && !android && !ios

package workbench

// Checks for the prompt library: seeding, reading, filtering, inserting
// and saving a draft.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestPromptLibrarySeeds checks the starter pack lands once and reads.
func TestPromptLibrarySeeds(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	app := &app{st: st}
	app.ensurePromptLibrary()
	list := app.loadPrompts()
	if len(list) < 10 {
		t.Fatalf("prompts = %d, want the starter pack", len(list))
	}
	cat := map[string]bool{}
	for _, p := range list {
		cat[p.Category] = true
	}
	for _, want := range []string{"代码理解", "代码修改", "调试", "文档", "计划"} {
		if !cat[want] {
			t.Errorf("category %q missing", want)
		}
	}
	// Seeding again must not overwrite the user's edits.
	path := filepath.Join(app.promptsDir(), "starter.json")
	if err := os.WriteFile(path, []byte(`{"name":"x","prompts":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	app.ensurePromptLibrary()
	if got := app.loadPrompts(); len(got) != 0 {
		t.Fatalf("seeding overwrote the folder: %+v", got)
	}
}

// TestFilterPrompts checks category, text and tag matching.
func TestFilterPrompts(t *testing.T) {
	list := []promptItem{
		{Title: "小步重构", Body: "不改变行为", Category: "代码修改", Tags: []string{"重构"}},
		{Title: "写 README", Body: "面向第一次接触的人", Category: "文档"},
	}
	if got := filterPrompts(list, "文档", ""); len(got) != 1 || got[0].Title != "写 README" {
		t.Fatalf("category filter = %+v", got)
	}
	if got := filterPrompts(list, "", "重构"); len(got) != 1 || got[0].Title != "小步重构" {
		t.Fatalf("query filter = %+v", got)
	}
	if got := filterPrompts(list, "", "README"); len(got) != 1 {
		t.Fatalf("body/title filter = %+v", got)
	}
	if got := filterPrompts(list, "", "不存在"); len(got) != 0 {
		t.Fatalf("no match = %+v", got)
	}
}

// TestPromptLibraryDialog checks a prompt goes into the composer and a
// draft can be saved back.
func TestPromptLibraryDialog(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	t.Setenv("PIDECK_LITE_HOME", home)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := openApp(t, workspace, 1280, 860)
	app.Key("mod+shift+p")
	app.WaitFor("id:prompt-library", 5*time.Second)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:梳理项目结构")) > 0 })
	app.Type("id:prompt-search", "重构")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:小步重构")) > 0 })
	app.Press("text:小步重构")
	app.WaitForGone("id:prompt-library", 5*time.Second)
	if got := app.Find("id:composer").Text; !strings.Contains(got, "不改变行为") {
		t.Fatalf("composer = %q", got)
	}

	// Save the draft as a prompt.
	app.Key("mod+shift+p")
	app.WaitFor("id:prompt-library", 5*time.Second)
	app.Press("id:prompt-save-draft")
	deadline := time.Now().Add(5 * time.Second)
	path := filepath.Join(home, "prompts", "user.json")
	for {
		raw, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(raw), "不改变行为") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("user.json = %s", raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
