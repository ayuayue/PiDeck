package main

// Checks hiding a session from the rail and showing it again.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestNormalizeArchived(t *testing.T) {
	c := config{Version: configVersion, Archived: []string{"a", "a", " ", "b"}, Titles: map[string]string{}}
	normalizeConfig(&c)
	if len(c.Archived) != 2 || c.Archived[0] != "a" || c.Archived[1] != "b" {
		t.Fatalf("Archived = %v", c.Archived)
	}
}

func TestArchiveSession(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "sessions", encodeCwd(workspace))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(id, prompt string) {
		body := fmt.Sprintf(`{"type":"session","version":3,"id":"%s","timestamp":"2026-06-01T10:00:00Z","cwd":%q}
{"type":"message","id":"u-%s","timestamp":"2026-06-01T10:00:01Z","message":{"role":"user","content":%q}}
`, id, workspace, id, prompt)
		if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a-1", "甲提问")
	write("b-1", "乙提问")
	cfg, err := json.Marshal(config{Version: 2,
		Workspaces:  []workspaceCfg{{Path: workspace, Name: "归档项目", Expanded: true}},
		Theme:       "system",
		SidebarOpen: true,
		ScanPi:      false,
		Titles:      map[string]string{"a-1": "甲会话", "b-1": "乙会话"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	rowOf := func() string {
		rows := app.Query("id:session-row")
		for i, r := range rows {
			if r.Props.Label == "甲会话" {
				return fmt.Sprintf("id:session-row >> nth=%d", i)
			}
		}
		return ""
	}
	app.WaitUntil(10*time.Second, func() bool { return rowOf() != "" })

	openMenu(t, app, rowOf(), "归档")
	app.Press("role:menuitem 归档")
	app.WaitUntil(5*time.Second, func() bool { return rowOf() == "" })

	// The palette still reaches it by name.
	app.Press("id:rail-palette")
	app.Type("label:命令", "甲会话")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option 甲会话")) > 0 })
	app.Press("role:option 甲会话")
	app.WaitFor("id:composer", 10*time.Second)

	// The archived dialog lists it and opens it.
	app.RightClick("id:project-row >> nth=0")
	app.WaitFor("role:menuitem 已归档…", 5*time.Second)
	app.Press("role:menuitem 已归档…")
	app.WaitFor("id:archive-dialog", 5*time.Second)
	app.WaitFor("id:archived-row", 5*time.Second)
	app.Press("id:archived-open >> nth=0")
	app.WaitFor("id:composer", 10*time.Second)

	// The project menu shows it again.
	app.RightClick("id:project-row >> nth=0")
	app.WaitFor("role:menuitem 显示已归档", 5*time.Second)
	app.Press("role:menuitem 显示已归档")
	app.WaitUntil(5*time.Second, func() bool { return rowOf() != "" })

	// Unarchiving takes it out of the archived list again.
	archived := func() []string {
		raw, err := os.ReadFile(filepath.Join(home, "config.json"))
		if err != nil {
			return nil
		}
		var c config
		if json.Unmarshal(raw, &c) != nil {
			return nil
		}
		return c.Archived
	}
	for i := 0; i < 6; i++ {
		app.RightClick(rowOf())
		if !waitQuiet(app, "role:menuitem 取消归档", 2*time.Second) {
			continue
		}
		app.Press("role:menuitem 取消归档")
		app.Settle()
		time.Sleep(100 * time.Millisecond)
		if len(archived()) == 0 {
			break
		}
	}
	if got := archived(); len(got) != 0 {
		t.Fatalf("archived = %v, want none", got)
	}
}
