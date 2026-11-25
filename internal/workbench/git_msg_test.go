//go:build !js && !android && !ios

package workbench

// Checks reusing a recent commit message from the commit box.

import (
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestGitRecentMessage(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, _ := gitFixture(t)
	app := startGitApp(t, dir)
	// One line names the newest subject, and the dropdown holds it and the
	// ones before it.
	app.WaitFor("id:git-msg-recent", 20*time.Second)
	app.Press("id:git-msg-recent")
	app.WaitFor("id:git-msg-recent-item >> nth=1", 5*time.Second)
	app.Press("id:git-msg-recent-item >> nth=0")
	app.WaitUntil(5*time.Second, func() bool { return strings.TrimSpace(app.Find("id:git-commit-message").Text) != "" })
	if got := strings.TrimSpace(app.Find("id:git-commit-message").Text); got != "second" {
		t.Fatalf("message = %q, want the newest subject", got)
	}
}
