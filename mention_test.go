package main

// Checks @ file completion in the composer: the token, the matches, and
// the chips that insert a path.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestMentionToken(t *testing.T) {
	if _, ok := mentionToken("没有提及"); ok {
		t.Fatal("a draft without @ had a token")
	}
	if token, ok := mentionToken("看下 @src/ap"); !ok || token != "src/ap" {
		t.Fatalf("token = %q, %v", token, ok)
	}
	if token, ok := mentionToken("@"); !ok || token != "" {
		t.Fatalf("bare @ = %q, %v", token, ok)
	}
	if _, ok := mentionToken("a@b.com"); ok {
		t.Fatal("an email was taken for a mention")
	}
	if _, ok := mentionToken("@src/app.go 已读"); ok {
		t.Fatal("a finished mention stayed open")
	}
}

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

func TestMentionBar(t *testing.T) {
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
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:mention-0")) > 0 })
	app.Press("id:mention-0")
	app.WaitUntil(5*time.Second, func() bool { return strings.Contains(app.Find("id:composer").Text, "@src/app.go") })
}
