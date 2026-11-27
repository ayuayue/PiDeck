//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestSettingsZipReloadsConfig(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	st.edit(func(c *config) { c.Theme = "dark" })
	path := filepath.Join(t.TempDir(), "settings.zip")
	if err := a.writeSettingsZip(path); err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) { c.Theme = "light" })
	if err := a.applySettingsZip(path); err != nil {
		t.Fatal(err)
	}
	if got := st.config().Theme; got != "dark" {
		t.Fatalf("in-memory theme after restore = %q, want dark", got)
	}
	// A queued save must serialize the restored config, not the old snapshot.
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	if got := readConfig(t, st.dir).Theme; got != "dark" {
		t.Fatalf("theme after subsequent save = %q, want dark", got)
	}
}

func TestSettingsZipWaitsForConfigWriter(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	path := filepath.Join(t.TempDir(), "settings.zip")
	if err := a.writeSettingsZip(path); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(st.path)
	if err != nil {
		t.Fatal(err)
	}
	st.writeMu.Lock()
	locked := true
	defer func() {
		if locked {
			st.writeMu.Unlock()
		}
	}()
	started, done := make(chan struct{}), make(chan error, 1)
	go func() {
		close(started)
		done <- a.applySettingsZip(path)
	}()
	<-started
	// A bounded observation window checks contention on the shared writer lock.
	select {
	case err := <-done:
		t.Fatalf("restore ran while a config writer held the lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if after, err := os.ReadFile(st.path); err != nil || string(after) != string(before) {
		t.Fatalf("config changed while writer lock was held: %v", err)
	}
	st.writeMu.Unlock()
	locked = false
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restore did not resume after the writer finished")
	}
}

func TestSettingsImportRefreshesFavorites(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless settings restore regression")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	st, err := newStore(home)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) {
		c.Pinned = []string{"restored-session"}
		c.FavModels = []string{"provider/restored-model"}
	})
	path := filepath.Join(t.TempDir(), "settings.zip")
	if err := (&app{st: st}).writeSettingsZip(path); err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) {
		c.Pinned = []string{"old-session"}
		c.FavModels = []string{"provider/old-model"}
	})
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	t.Cleanup(built.closeDiag)
	screen.Post(func() {
		built.importSettings(path)
		built.confirm()
	})
	screen.WaitUntil(5*time.Second, func() bool {
		return slices.Equal(built.pinned.GetUntracked(), []string{"restored-session"}) &&
			slices.Equal(built.favModels.GetUntracked(), []string{"provider/restored-model"})
	})
	screen.Post(func() {
		built.togglePin(&session{ID: "new-session"})
		built.toggleFavModel(modelInfo{Provider: "provider", ID: "new-model"})
	})
	screen.Settle()
	got := readConfig(t, home)
	if !slices.Equal(got.Pinned, []string{"restored-session", "new-session"}) {
		t.Fatalf("pins after the next toggle = %v", got.Pinned)
	}
	if !slices.Equal(got.FavModels, []string{"provider/restored-model", "provider/new-model"}) {
		t.Fatalf("favorite models after the next toggle = %v", got.FavModels)
	}
}
