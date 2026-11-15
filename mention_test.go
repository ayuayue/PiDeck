package main

// Checks @ file completion in the composer: the matches and the
// suggestion list that inserts a path.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMentionMatches(t *testing.T) {
	files := []string{"src/app.go", "src/main.go", "README.md", "docs/app.md"}
	got := mentionMatches(files, "app", 8)
	if len(got) != 2 || got[0] != "src/app.go" || got[1] != "docs/app.md" {
		t.Fatalf("matches = %v", got)
	}
	if got := mentionMatches(files, "read", 8); len(got) != 1 || got[0] != "README.md" {
		t.Fatalf("case-insensitive = %v", got)
	}
	if got := mentionMatches(files, "", 2); len(got) != 2 {
		t.Fatalf("limit = %v", got)
	}
}

func TestMentionSuggest(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(workspace, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "src", "app.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := startApp(t, workspace, 1280, 860)
	app.Type("id:composer", "@app")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:composer-suggestions")) > 0 })
	app.Key("enter")
	app.WaitUntil(5*time.Second, func() bool { return strings.Contains(app.Find("id:composer").Text, "@src/app.go") })
}
