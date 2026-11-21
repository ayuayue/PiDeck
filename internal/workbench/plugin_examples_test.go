//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestBuiltinPluginExamplesUI(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless UI contract; platform runs are for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.Press("label:设置")
	app.Press("id:settings-tab-addons")
	app.Press("id:plugin-market-open")
	app.WaitFor("id:market-examples", 5*time.Second)
	for _, entry := range builtinPluginExamples() {
		app.WaitFor("id:market-entry-"+entry.ID, 5*time.Second)
	}
	app.Press("id:market-install-lite-ui-basics")
	app.WaitFor("text:已安装 v1.0.0", 15*time.Second)
	app.Press("id:market-close")
	for _, id := range []string{"detailed", "topic", "points", "format-要点"} {
		app.WaitFor("id:plugin-setting-lite-ui-basics-"+id, 5*time.Second)
	}
	app.Press("id:plugin-setting-lite-ui-basics-detailed")
	app.WaitUntil(5*time.Second, func() bool {
		return !app.Find("id:plugin-setting-lite-ui-basics-detailed").Props.Checked
	})
}

func TestLegacyPluginIdentityMigrationDoesNotRewriteManifest(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(st.dir, "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "legacy.json")
	raw := `{"id":"legacy","name":"Legacy","prompts":[{"title":"Hello","prompt":"hello"}]}`
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &app{st: st, cfg: st.config()}
	list := a.loadPlugins(nil)
	if len(list) != 1 || list[0].Runtime != litePluginRuntime || list[0].SchemaVersion != litePluginSchema || len(list[0].Commands) != 1 {
		t.Fatalf("legacy migration=%+v", list)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != raw {
		t.Fatalf("loader rewrote legacy manifest: %q, %v", got, err)
	}
}
