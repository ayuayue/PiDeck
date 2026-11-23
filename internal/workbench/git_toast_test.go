//go:build !js && !android && !ios

package workbench

// Checks that the drawer's remote actions report what they did: a push
// names where it went, a pull says nothing came in when nothing did.

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGitPushReportsWhereItWent(t *testing.T) {
	dir, run := gitFixture(t)
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("third\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("commit", "-am", "third")
	app := startGitDesktop(t, dir)
	app.WaitFor("id:git-push", 20*time.Second)
	app.Press("id:git-push")
	waitApp(app, "text:已推送到 origin/main", 30*time.Second)
}

func TestGitPullReportsNothingNew(t *testing.T) {
	dir, _ := gitFixture(t)
	app := startGitDesktop(t, dir)
	app.WaitFor("id:git-pull", 20*time.Second)
	app.Press("id:git-pull")
	waitApp(app, "text:已经是最新的", 30*time.Second)
}
