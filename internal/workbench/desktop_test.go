//go:build !js && !android && !ios

package workbench

// Checks for the desktop settings and the notification decision.

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestShouldNotify checks the master switch and the hidden-only rule.
func TestShouldNotify(t *testing.T) {
	cases := []struct {
		cfg     config
		visible bool
		want    bool
	}{
		{config{NotifyOnDone: false}, false, false},
		{config{NotifyOnDone: true, NotifyOnlyHidden: true}, true, false},
		{config{NotifyOnDone: true, NotifyOnlyHidden: true}, false, true},
		{config{NotifyOnDone: true, NotifyOnlyHidden: false}, true, true},
	}
	for _, c := range cases {
		if got := shouldNotify(c.cfg, c.visible); got != c.want {
			t.Errorf("shouldNotify(%+v, %v) = %v, want %v", c.cfg, c.visible, got, c.want)
		}
	}
}

// TestDesktopConfigDefaults checks old configs gain the tray and
// notification defaults while explicit choices survive.
func TestDesktopConfigDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"theme":"dark"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := st.config()
	if !c.CloseToTray || !c.NotifyOnDone || !c.NotifyOnlyHidden {
		t.Fatalf("old config defaults = %+v", c)
	}
	if err := os.WriteFile(path, []byte(`{"closeToTray":false,"notifyOnDone":false,"notifyOnlyHidden":false}`), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err = newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	c = st.config()
	if c.CloseToTray || c.NotifyOnDone || c.NotifyOnlyHidden {
		t.Fatalf("explicit choices were overridden: %+v", c)
	}
}

// TestRetiredDesktopPet checks an old enabled config remains readable,
// but opens no pet window and exposes no controls for the retired feature.
func TestRetiredDesktopPet(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	for _, platform := range []struct {
		name string
		os   core.OS
	}{
		{"windows", core.OSWindows},
		{"linux", core.OSLinux},
	} {
		t.Run(platform.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("PIDECK_V2_HOME", home)
			if err := os.WriteFile(filepath.Join(home, "config.json"),
				[]byte(`{"petEnabled":true,"petPackage":"missing-pet","sidebarOpen":true,"scanPi":false,"telemetryEnabled":false}`), 0o600); err != nil {
				t.Fatal(err)
			}
			var built *app
			screen := nsgotest.StartApp(t, func(cx *core.Scope) {
				// App mode allows auxiliary windows, so an accidental return
				// of the old pet would be observable on Windows as well.
				nsgo.SetMainView(cx, func(cx *core.Scope) core.Node {
					built = newApp(cx)
					return built.view()
				})
			}, nsgotest.Size(1200, 800),
				nsgotest.Environment(core.Environment{OS: platform.os, Idiom: core.IdiomDesktop}))
			if len(screen.Opened) != 1 {
				t.Fatalf("legacy pet config opened %d windows, want only the main window: %+v", len(screen.Opened), screen.Opened)
			}
			if !built.cfg.PetEnabled || built.cfg.PetPackage != "missing-pet" {
				t.Fatal("retired pet fields were not preserved for config compatibility")
			}
			for _, item := range built.trayMenu() {
				if item.Label == "桌面宠物" {
					t.Fatal("tray menu still exposes the retired desktop pet")
				}
			}
			screen.Press("label:设置")
			screen.Press("id:settings-tab-general")
			screen.WaitFor("id:notify-done", 5*time.Second)
			for _, selector := range []string{"id:pet-enabled", "id:pet-package", "id:pet-package-reset"} {
				if len(screen.QueryMounted(selector)) != 0 {
					t.Errorf("settings still expose retired pet control %s", selector)
				}
			}
		})
	}
}
