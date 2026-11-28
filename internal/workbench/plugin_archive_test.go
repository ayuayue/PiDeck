//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func writePluginFixture(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func onlyPlugin(t *testing.T, a *app) plugin {
	t.Helper()
	list := a.loadPlugins(a.cfg.DisabledPlugins)
	if len(list) != 1 || list[0].Error != "" {
		t.Fatalf("installed plugins = %+v, want a single valid plugin", list)
	}
	return list[0]
}

func onlyArchivedPlugin(t *testing.T, a *app) archivedPlugin {
	t.Helper()
	list, err := a.archivedPlugins()
	if err != nil || len(list) != 1 {
		t.Fatalf("archived plugins = %+v (%v), want one", list, err)
	}
	return list[0]
}

func assertPluginFile(t *testing.T, path, want string) {
	t.Helper()
	if got, err := os.ReadFile(path); err != nil || string(got) != want {
		t.Fatalf("%s = %q (%v), want %q", filepath.Base(path), got, err, want)
	}
}

func TestPluginArchiveRoundTripPreservesFilesAndConfig(t *testing.T) {
	for _, tc := range []struct {
		name, manifest string
		folder         bool
	}{
		{"previously seeded flat example", "example-plugin.json", false},
		{"folder with theme", "team/plugin.json", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, err := newStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			st.edit(func(c *config) {
				c.DisabledPlugins = []string{"example"}
				c.PluginSettings = map[string]string{"example/tone": "kept"}
			})
			a := &app{st: st, cfg: st.config()}
			path := filepath.Join(a.pluginsDir(), tc.manifest)
			const theme = `{"id":"mist","name":"Mist","light":{"accent":"#2563eb"}}`
			body := `{"id":"example","name":"Team","version":"1.0.0","contributes":{"settings":[{"key":"tone","label":"Tone","type":"string","default":"plain"}]`
			if tc.folder {
				writePluginFixture(t, filepath.Join(filepath.Dir(path), "themes", "mist.json"), theme)
				body += `,"themes":["themes/mist.json"]`
			}
			body += `}}`
			writePluginFixture(t, path, body)
			p := onlyPlugin(t, a)
			if err := a.archivePlugin(p); err != nil {
				t.Fatal(err)
			}
			// Opening the app or the plugins folder must not recreate a
			// previously seeded example once the user has removed it.
			a.ensureAddonDirs()
			if got := a.loadPlugins(nil); len(got) != 0 {
				t.Fatalf("uninstalled plugin still loads: %+v", got)
			}
			st, err = newStore(st.dir)
			if err != nil {
				t.Fatal(err)
			}
			a = &app{st: st, cfg: st.config()}
			item := onlyArchivedPlugin(t, a)
			if err := a.restoreArchivedPlugin(item); err != nil {
				t.Fatal(err)
			}
			assertPluginFile(t, path, body)
			p = onlyPlugin(t, a)
			if !p.Disabled || pluginSettingValue(a.cfg.PluginSettings, p, "tone") != "kept" {
				t.Fatalf("restore lost config: disabled=%v, settings=%v", p.Disabled, a.cfg.PluginSettings)
			}
			if tc.folder {
				assertPluginFile(t, filepath.Join(filepath.Dir(path), "themes", "mist.json"), theme)
				if len(p.ThemeSpecs) != 1 || p.ThemeSpecs[0].ID != "plugin:example:mist" {
					t.Fatalf("restore lost its relative theme: %+v", p.ThemeSpecs)
				}
			}
			if got, err := a.archivedPlugins(); err != nil || len(got) != 0 {
				t.Fatalf("restored archive = %+v (%v), want empty", got, err)
			}
		})
	}
}

func TestPluginArchiveRejectsConflictsAndChangedFiles(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	path := filepath.Join(a.pluginsDir(), "team.json")
	const original = `{"id":"team","name":"Team"}`
	const edited = `{"id":"team","name":"Edited"}`
	writePluginFixture(t, path, original)
	p := onlyPlugin(t, a)
	writePluginFixture(t, path, edited)
	if err := a.archivePlugin(p); err == nil {
		t.Fatal("uninstalled a manifest changed after it was shown")
	}
	assertPluginFile(t, path, edited)
	if err := a.archivePlugin(onlyPlugin(t, a)); err != nil {
		t.Fatal(err)
	}
	item := onlyArchivedPlugin(t, a)
	copyPath := filepath.Join(st.dir, pluginArchiveDir, item.slot, item.name)
	for _, tc := range []struct{ path, body, reason string }{
		{path, `{"id":"other"}`, apptext.T("原插件路径已被占用")},
		{filepath.Join(a.pluginsDir(), "different.json"), original, apptext.T("存在重复的插件 id：%s", "team")},
	} {
		writePluginFixture(t, tc.path, tc.body)
		if err := a.restoreArchivedPlugin(item); err == nil || err.Error() != tc.reason {
			t.Fatalf("restore with %s = %v, want %s", filepath.Base(tc.path), err, tc.reason)
		}
		assertPluginFile(t, tc.path, tc.body)
		assertPluginFile(t, copyPath, edited)
		if err := os.Remove(tc.path); err != nil {
			t.Fatal(err)
		}
	}
	writePluginFixture(t, copyPath, original)
	if err := a.restoreArchivedPlugin(item); err == nil {
		t.Fatal("restored a changed archived manifest from a stale row")
	}
	assertPluginFile(t, copyPath, original)
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("refused restore left a target: %v", err)
	}
}

func TestPluginArchiveCanRecoverBrokenAndForeignManifests(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	for _, tc := range []struct{ name, body string }{
		{"broken.json", `{"id":`},
		{"foreign.json", `{"schemaVersion":1,"runtime":"pideck-electron","id":"foreign","name":"Foreign"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(a.pluginsDir(), tc.name)
			writePluginFixture(t, path, tc.body)
			var candidate *plugin
			for _, p := range a.loadPlugins(nil) {
				if p.Path == path {
					cp := p
					candidate = &cp
				}
			}
			if candidate == nil || candidate.Error == "" || !canArchivePlugin(*candidate) {
				t.Fatalf("invalid manifest is not removable: %+v", candidate)
			}
			if err := a.archivePlugin(*candidate); err != nil {
				t.Fatal(err)
			}
			items, err := a.archivedPlugins()
			if err != nil {
				t.Fatal(err)
			}
			var item *archivedPlugin
			for _, archived := range items {
				if archived.name == tc.name {
					cp := archived
					item = &cp
				}
			}
			if item == nil || item.problem == "" {
				t.Fatalf("archive recovery row = %+v", item)
			}
			if err := a.restoreArchivedPlugin(*item); err != nil {
				t.Fatal(err)
			}
			assertPluginFile(t, path, tc.body)
		})
	}
}

func TestPluginArchiveRepeatedCopiesHaveDistinctRestoreControls(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	for range 2 {
		writePluginFixture(t, filepath.Join(a.pluginsDir(), "team.json"), `{"id":"team","name":"Team"}`)
		if err := a.archivePlugin(onlyPlugin(t, a)); err != nil {
			t.Fatal(err)
		}
	}
	items, err := a.archivedPlugins()
	if err != nil || len(items) != 2 {
		t.Fatalf("archive=%+v, err=%v, want two copies", items, err)
	}
	if archivedPluginTestID(items[0]) == archivedPluginTestID(items[1]) {
		t.Fatal("distinct archived copies share a restore control ID")
	}
}

func TestPluginArchiveUIUpdatesMarketAndRestoresSettings(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless UI contract; platform runs are for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	st, err := newStore(home)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) { c.PluginSettings = map[string]string{"v2-ui-basics/detailed": "false"} })
	a := &app{st: st}
	var example marketEntry
	for _, entry := range builtinPluginExamples() {
		if entry.ID == "v2-ui-basics" {
			example = entry
			break
		}
	}
	if example.ID == "" {
		t.Fatal("v2-ui-basics example is missing")
	}
	if _, err := a.installMarketPlugin(example); err != nil {
		t.Fatal(err)
	}
	screen := nsgotest.Start(t, Root, nsgotest.Size(1280, 900))
	screen.Press("label:设置")
	screen.Press("id:settings-tab-addons")
	screen.WaitFor("id:plugin-uninstall-v2-ui-basics", 10*time.Second)
	screen.Press("id:plugin-uninstall-v2-ui-basics")
	screen.WaitForGone("id:plugin-toggle-v2-ui-basics", 5*time.Second)
	item := onlyArchivedPlugin(t, a)
	screen.Press("id:plugin-market-open")
	screen.WaitFor("id:market-install-v2-ui-basics", 5*time.Second)
	screen.Press("id:market-close")
	screen.Press("id:" + archivedPluginTestID(item))
	screen.WaitFor("id:plugin-toggle-v2-ui-basics", 5*time.Second)
	setting := screen.WaitFor("id:plugin-setting-v2-ui-basics-detailed", 5*time.Second)
	if setting.Props.Checked {
		t.Fatal("restored plugin reset the saved setting to its default")
	}
	screen.WaitForGone("id:"+archivedPluginTestID(item), 5*time.Second)
}
