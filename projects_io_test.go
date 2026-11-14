package main

// Checks sharing a project list: its bytes, parsing, and the export.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestProjectExportParse(t *testing.T) {
	list := []*workspace{
		{Path: "/work/shop", Name: "商店", Group: "工作", Pinned: true, Target: localTarget, ACPPreset: "claude"},
		{Path: "/data/chat", Name: "对话", Chat: true},
	}
	raw, err := projectExportJSON(list)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "/data/chat") {
		t.Fatalf("the built-in chat was exported:\n%s", raw)
	}
	got, err := parseProjectExport(raw)
	if err != nil || len(got) != 1 {
		t.Fatalf("parse = %+v, %v", got, err)
	}
	if got[0].Path != "/work/shop" || got[0].Name != "商店" || got[0].Group != "工作" || !got[0].Pinned || got[0].ACPPreset != "claude" {
		t.Fatalf("project = %+v", got[0])
	}
	bare, err := parseProjectExport([]byte(`[{"path":"/a","name":"A"}]`))
	if err != nil || len(bare) != 1 || bare[0].Name != "A" {
		t.Fatalf("bare = %+v, %v", bare, err)
	}
	if _, err := parseProjectExport([]byte(`{"projects":[]}`)); err == nil {
		t.Fatal("an empty list parsed")
	}
}

func TestExportProjects(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := startApp(t, workspace, 1280, 860)
	app.Press("id:rail-palette")
	app.WaitFor("id:palette", 10*time.Second)
	app.Type("label:命令", "导出项目列表")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option 导出项目列表…")) > 0 })
	app.Press("role:option 导出项目列表…")
	deadline := time.Now().Add(5 * time.Second)
	for {
		entries, err := os.ReadDir(filepath.Join(home, "exports"))
		if err == nil {
			for _, e := range entries {
				if strings.HasPrefix(e.Name(), "projects-") {
					raw, _ := os.ReadFile(filepath.Join(home, "exports", e.Name()))
					if strings.Contains(string(raw), filepath.Base(workspace)) {
						return
					}
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no project list under exports: %v", entries)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
