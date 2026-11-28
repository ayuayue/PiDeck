//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDirectoryImportAdoptsIdleExternalSession(t *testing.T) {
	t.Setenv("PIDECK_V2_LEGACY_HOME", "")
	built, screen := startNativeSettingsApp(t)
	screen.WaitUntil(10*time.Second, func() bool { return !built.transfer.GetUntracked().running() })
	directory, project := t.TempDir(), t.TempDir()
	path := filepath.Join(directory, "session.jsonl")
	legacyPiFixture(t, path, "already-listed", project)
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var listed *session
	onNativeUI(t, screen, built, func() {
		built.mergeTransferredSessions(nil, []workspaceCfg{{Path: project}}, nil, nil)
		listed = built.makeSession(sessionMeta{ID: "already-listed", Cwd: project, File: path, External: true}, localTarget)
		listed.draft.Set("keep the current draft")
		built.workspaceOf(project).Pi.Set([]*session{listed})
		built.importSessionDirectory(directory)
	})
	screen.WaitUntil(10*time.Second, func() bool { return built.transfer.GetUntracked().Status == "completed" })
	if built.byID[listed.ID] != listed || listed.External || listed.File == path {
		t.Fatalf("idle session was not adopted in place: external=%v file=%s", listed.External, listed.File)
	}
	if !pathWithin(built.st.sessions, listed.File) || listed.draft.GetUntracked() != "keep the current draft" {
		t.Fatal("adopting the copy lost the private path or draft")
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != string(original) {
		t.Fatal("directory import changed the source")
	}
}

func TestSessionTransferDismissedBannerStaysHidden(t *testing.T) {
	t.Setenv("PIDECK_V2_LEGACY_HOME", "")
	built, screen := startNativeSettingsApp(t)
	screen.WaitUntil(10*time.Second, func() bool { return !built.transfer.GetUntracked().running() })
	onNativeUI(t, screen, built, func() {
		built.transfer.Set(sessionTransferState{Kind: "directory", Status: "copying", Source: "fixture", Done: 1, Total: 4, Visible: true})
	})
	screen.WaitFor("id:session-transfer-hide", 5*time.Second)
	screen.Press("id:session-transfer-hide")
	onNativeUI(t, screen, built, func() {
		built.updateTransferProgress(sessionTransferState{Kind: "directory", Status: "copying", Source: "fixture", Done: 2, Total: 4, Visible: true})
	})
	if screen.Exists("id:session-transfer-banner") {
		t.Fatal("a progress update reopened the dismissed banner")
	}
	if built.transfer.GetUntracked().Done != 2 {
		t.Fatal("hiding the banner stopped progress updates")
	}
}

func TestDirectoryImportEmptyDirectoryShowsRecovery(t *testing.T) {
	t.Setenv("PIDECK_V2_LEGACY_HOME", "")
	built, screen := startNativeSettingsApp(t)
	screen.WaitUntil(10*time.Second, func() bool { return !built.transfer.GetUntracked().running() })
	directory := t.TempDir()
	onNativeUI(t, screen, built, func() { built.importSessionDirectory(directory) })
	screen.WaitUntil(10*time.Second, func() bool { return built.transfer.GetUntracked().Status == "failed" })
	screen.Press("id:session-transfer-details")
	screen.WaitFor("id:session-transfer-help", 5*time.Second)
	screen.Find("text:所选目录中没有可导入的 pi 会话，请选择会话文件所在目录。")
}
