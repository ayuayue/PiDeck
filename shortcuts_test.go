package main

// Checks for the keyboard cheat sheet.

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestShortcutsDialog opens the sheet, searches and closes it.
func TestShortcutsDialog(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Key("mod+/")
	app.WaitFor("id:shortcuts", 5*time.Second)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:shortcuts >> text:新建会话")) > 0 })
	app.Type("id:shortcuts-search", "保存")

	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:shortcuts >> text:保存文件")) > 0 })
	if len(app.Query("id:shortcuts >> text:新建会话")) != 0 {
		t.Fatal("a filtered-out command is still listed")
	}
	app.Press("id:shortcuts-close")
	app.WaitForGone("id:shortcuts", 5*time.Second)
}
