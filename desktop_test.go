package main

// Checks for the desktop settings and the notification decision.

import (
	"os"
	"path/filepath"
	"testing"
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
