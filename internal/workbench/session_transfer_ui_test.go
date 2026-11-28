//go:build !js && !android && !ios

package workbench

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestLegacyMigrationFirstLaunchAndCompletion(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless startup and persistence test")
	}
	source, destination, sessions, _ := setupLegacyFixture(t)
	t.Setenv("PIDECK_V2_HOME", destination)
	t.Setenv("PIDECK_V2_LEGACY_HOME", source)
	t.Run("first launch", func(t *testing.T) {
		var built *app
		screen := nsgotest.Start(t, func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }, nsgotest.Size(1200, 800))
		screen.WaitUntil(15*time.Second, func() bool { return built.transfer.GetUntracked().Status == "completed" })
		screen.WaitFor("id:session-transfer-banner", 5*time.Second)
		if built.byID["native-1"] == nil || built.byID["native-1"].WS != filepath.Join(destination, "chat") {
			t.Fatal("migrated chat did not appear")
		}
		screen.Press("id:session-transfer-details")
		screen.WaitFor("id:session-transfer-summary", 5*time.Second)
		record, err := readLegacyMigration(destination)
		if err != nil || record.Status != "completed" {
			t.Fatalf("marker = %+v, %v", record, err)
		}
		st, err := newStore(destination)
		if err != nil {
			t.Fatal(err)
		}
		if st.config().Titles["native-1"] != "Saved title" {
			t.Fatal("title was not persisted before completion")
		}
	})
	legacyPiFixture(t, filepath.Join(sessions, encodeCwd(filepath.Join(source, "chat-workspace")), "later_native-2.jsonl"), "native-2", filepath.Join(source, "chat-workspace"))
	t.Run("next launch", func(t *testing.T) {
		var built *app
		screen := nsgotest.Start(t, func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }, nsgotest.Size(1200, 800))
		screen.WaitUntil(10*time.Second, func() bool { return built.transfer.GetUntracked().Status != "checking" })
		if built.transfer.GetUntracked().Status != "completed" {
			t.Fatal("completion state was not restored")
		}
		if len(sessionFiles(built.st.sessions)) != 1 {
			t.Fatal("completed migration ran again")
		}
		if screen.Exists("id:session-transfer-banner") {
			t.Fatal("successful migration banner reappeared on next launch")
		}
	})
}

func TestLegacyMigrationResumesRunningMarker(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless startup and persistence test")
	}
	source, destination, _, _ := setupLegacyFixture(t)
	t.Setenv("PIDECK_V2_HOME", destination)
	t.Setenv("PIDECK_V2_LEGACY_HOME", source)
	st, err := newStore(destination)
	if err != nil {
		t.Fatal(err)
	}
	result := runLegacyMigration(context.Background(), st, source, func(sessionTransferState) {})
	if result.Err != nil {
		t.Fatal(result.Err)
	}
	// Simulate exiting after the copies and an unrelated config save, but
	// before publishing the imported projects, titles and completed marker.
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }, nsgotest.Size(1200, 800))
	screen.WaitUntil(15*time.Second, func() bool { return built.transfer.GetUntracked().Status == "completed" })
	state := built.transfer.GetUntracked()
	if state.Imported != 0 || state.Skipped < 1 || len(sessionFiles(built.st.sessions)) != 1 {
		t.Fatalf("resume duplicated a copied session: %+v", state)
	}
	if built.byID["native-1"] == nil || built.cfg.Titles["native-1"] != "Saved title" || !slices.Contains(built.cfg.Pinned, "native-1") {
		t.Fatal("resume did not publish the pending session metadata")
	}
}

func TestLegacyMigrationFailureShowsManualRecovery(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless startup and picker test")
	}
	source, destination, _, _ := setupLegacyFixture(t)
	t.Setenv("PIDECK_V2_HOME", destination)
	t.Setenv("PIDECK_V2_LEGACY_HOME", source)
	if err := os.WriteFile(filepath.Join(source, "projects.json"), []byte("broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }, nsgotest.Size(1200, 800))
	screen.WaitUntil(15*time.Second, func() bool { return built.transfer.GetUntracked().Status == "failed" })
	screen.Press("id:session-transfer-details")
	screen.WaitFor("id:session-transfer-help", 5*time.Second)
	screen.Find("id:legacy-migration-retry")
	screen.Find("id:session-transfer-import-directory")
	record, err := readLegacyMigration(destination)
	if err != nil || record.Status != "failed" || record.Error == "" {
		t.Fatalf("failed marker = %+v, %v", record, err)
	}
}

func TestDirectoryImportPickerImportsNestedSessions(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless native picker fixture")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	t.Setenv("PIDECK_V2_LEGACY_HOME", "")
	directory, project := t.TempDir(), t.TempDir()
	legacyPiFixture(t, filepath.Join(directory, "nested", "old_picked-1.jsonl"), "picked-1", project)
	if err := os.WriteFile(filepath.Join(directory, "foreign.jsonl"), []byte("{\"type\":\"response_item\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }, nsgotest.Size(1200, 800))
	screen.WaitUntil(10*time.Second, func() bool { return !built.transfer.GetUntracked().running() })
	screen.PickDirectories = func(nsgotest.DirectoryPick) []core.Directory {
		return []core.Directory{{Name: "sessions", Path: directory}}
	}
	screen.Press("text:导入会话")
	screen.WaitFor("id:import-directory", 5*time.Second)
	screen.Press("id:import-directory")
	screen.WaitUntil(15*time.Second, func() bool { return built.transfer.GetUntracked().Status == "completed" })
	screen.WaitFor("id:session-transfer-summary", 5*time.Second)
	if built.byID["picked-1"] == nil || built.workspaceOf(project) == nil {
		t.Fatal("directory import did not add the session and workspace")
	}
	if state := built.transfer.GetUntracked(); state.Imported != 1 || state.Skipped != 1 {
		t.Fatalf("result = %+v", state)
	}
	screen.Press("id:session-transfer-import-directory")
	screen.WaitUntil(15*time.Second, func() bool {
		state := built.transfer.GetUntracked()
		return state.Status == "completed" && state.Imported == 0
	})
	if len(sessionFiles(built.st.sessions)) != 1 {
		t.Fatal("directory was imported twice")
	}
}
