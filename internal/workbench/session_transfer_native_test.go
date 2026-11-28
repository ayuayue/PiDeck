//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// Startup/copy behavior is tested with real files in the headless tests.
// This fixture verifies the same progress and recovery views on native hosts.
func TestSessionTransferProgressAndRecoveryLayout(t *testing.T) {
	t.Setenv("PIDECK_V2_LEGACY_HOME", "")
	built, screen := startNativeSettingsApp(t)
	screen.WaitUntil(10*time.Second, func() bool { return !built.transfer.GetUntracked().running() })
	onNativeUI(t, screen, built, func() {
		built.transfer.Set(sessionTransferState{Kind: "legacy", Status: "copying", Source: built.st.dir,
			Done: 1, Total: 4, Imported: 1, Visible: true})
	})
	screen.WaitFor("id:session-transfer-banner-progress", 5*time.Second)
	screen.Press("id:session-transfer-details")
	screen.WaitFor("id:session-transfer-progress", 5*time.Second)
	screen.Find("id:session-transfer-dialog >> text:已处理 1 / 4 个文件")
	if screen.Exists("id:session-transfer-import-directory") {
		t.Fatal("manual import must wait for the running transfer")
	}
	if nsgotest.Target() != "" {
		screen.Screenshot("migration/progress")
	}
	onNativeUI(t, screen, built, func() {
		s := built.transfer.GetUntracked()
		s.Status, s.Error = "failed", strings.Repeat("Permission denied while opening a session file. ", 12)
		built.transfer.Set(s)
	})
	screen.Resize(900, 700)
	screen.WaitFor("id:legacy-migration-retry", 5*time.Second)
	screen.Find("id:session-transfer-import-directory")
	dialog := screen.Find("id:session-transfer-dialog").Bounds()
	for _, id := range []string{"legacy-migration-retry", "session-transfer-import-directory"} {
		bounds := screen.Find("id:" + id).Bounds()
		if bounds.Origin.X < dialog.Origin.X || bounds.Origin.X+bounds.Size.Width > dialog.Origin.X+dialog.Size.Width {
			t.Fatalf("%s overflows the dialog: control=%+v dialog=%+v", id, bounds, dialog)
		}
	}
	if nsgotest.Target() != "" {
		screen.Screenshot("migration/recovery-narrow")
	}
}
