//go:build !js && !android && !ios

package workbench

// Checks the settings backup: what it carries, restoring it, and refusing
// unsafe zips.

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestSettingsBackup(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) { c.Theme = "dark" })
	a := &app{st: st}
	a.cfg = st.config()
	if err := os.MkdirAll(filepath.Join(dir, "plugins"), 0o755); err != nil {
		t.Fatal(err)
	}
	plugin := filepath.Join(dir, "plugins", "a.json")
	pluginBody := []byte(`{"id":"a","name":"A","contributes":{"commands":[]}}`)
	if err := os.WriteFile(plugin, pluginBody, 0o644); err != nil {
		t.Fatal(err)
	}
	archivedPlugin := filepath.Join(dir, pluginArchiveDir, "slot", "a.json")
	if err := os.MkdirAll(filepath.Dir(archivedPlugin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archivedPlugin, pluginBody, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "sessions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sessions", "x.jsonl"), []byte("private"), 0o644); err != nil {
		t.Fatal(err)
	}
	zipPath := filepath.Join(dir, "backup.zip")
	if err := a.writeSettingsZip(zipPath); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	zr.Close()
	for _, want := range []string{"config.json", "plugins/a.json", "trash/plugins/slot/a.json"} {
		if !names[want] {
			t.Errorf("backup lacks %s", want)
		}
	}
	for name := range names {
		if strings.HasPrefix(name, "sessions/") {
			t.Errorf("backup carries a session: %s", name)
		}
	}
	if err := os.Remove(plugin); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(archivedPlugin); err != nil {
		t.Fatal(err)
	}
	if err := a.applySettingsZip(zipPath); err != nil {
		t.Fatal(err)
	}
	if err := st.reload(); err != nil {
		t.Fatal(err)
	}
	if got := st.config().Theme; got != "dark" {
		t.Fatalf("theme after import = %q", got)
	}
	raw, err := os.ReadFile(plugin)
	if err != nil || !strings.Contains(string(raw), `"id":"a"`) {
		t.Fatalf("restored plugin = %s, %v", raw, err)
	}
	assertPluginFile(t, archivedPlugin, string(pluginBody))
}

func TestSettingsZipRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.zip")
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("../evil.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("x"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &app{st: &store{dir: dir}}
	if _, err := a.settingsZipNames(path); err == nil {
		t.Fatal("a traversal entry was accepted")
	}
}

func TestSettingsBackupIncludesOnlyPluginTrash(t *testing.T) {
	for _, tc := range []struct {
		path string
		want bool
	}{
		{"trash/plugins/slot/plugin.json", true},
		{"trash/plugins/slot/team/themes/blue.json", true},
		{"trash/plugins-old/slot/plugin.json", false},
		{"trash/sessions/private.jsonl", false},
		{"trash/theme.json", false},
	} {
		if got := backupPathAllowed(tc.path); got != tc.want {
			t.Errorf("backupPathAllowed(%q)=%v, want %v", tc.path, got, tc.want)
		}
	}
}

func TestSettingsExportUI(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-data")
	app.WaitFor("id:settings-export", 5*time.Second)
	app.Press("id:settings-export")
	app.WaitUntil(5*time.Second, func() bool {
		files, err := filepath.Glob(filepath.Join(home, "exports", "settings-*.zip"))
		return err == nil && len(files) > 0
	})
}
