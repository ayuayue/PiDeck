//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWaitingNotificationConfigMigration(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want bool
	}{
		{"fresh", "", true},
		{"legacy", `{"version":4,"notifyOnDone":false}`, true},
		{"explicit-off", `{"version":4,"notifyOnWaiting":false}`, false},
		{"current-on", fmt.Sprintf(`{"version":%d,"notifyOnWaiting":true}`, configVersion), true},
		{"current-off", fmt.Sprintf(`{"version":%d,"notifyOnWaiting":false}`, configVersion), false},
		{"invalid-config", `{invalid`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "config.json")
			if tc.raw != "" {
				if err := os.WriteFile(path, []byte(tc.raw), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			st, err := newStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			if c := st.config(); c.NotifyOnWaiting != tc.want || c.Version != configVersion {
				t.Fatalf("waiting notification/version = %t/%d, want %t/%d", c.NotifyOnWaiting, c.Version, tc.want, configVersion)
			}
			if err := st.save(); err != nil {
				t.Fatal(err)
			}
			reloaded, err := newStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			if got := reloaded.config().NotifyOnWaiting; got != tc.want {
				t.Fatalf("reloaded waiting notification = %t, want %t", got, tc.want)
			}
		})
	}
}

func TestWaitingNotificationSettingPersists(t *testing.T) {
	a, screen, _ := newAskApp(t)
	screen.Press("label:设置")
	screen.Press("id:settings-tab-general")
	screen.WaitFor("id:notify-waiting", 5*time.Second)
	for _, want := range []bool{true, false} {
		screen.Press("id:notify-waiting")
		screen.Settle()
		if got := a.cfg.NotifyOnWaiting; got != want {
			t.Fatalf("waiting notification setting = %t, want %t", got, want)
		}
		reloaded, err := newStore(a.dataDir)
		if err != nil {
			t.Fatal(err)
		}
		if got := reloaded.config().NotifyOnWaiting; got != want {
			t.Fatalf("saved waiting notification = %t, want %t", got, want)
		}
	}
	path := filepath.Join(a.dataDir, "config.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newStore(a.dataDir); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("reopening the saved notification choice rewrote the config")
	}
}
