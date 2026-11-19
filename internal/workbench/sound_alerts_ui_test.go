//go:build !js && !android && !ios

package workbench

// The sound settings are a switch the user can reach and that survives a
// restart; the player's own choices are unit-tested beside it.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestSettingsSoundSwitch(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.WaitFor("id:settings-search", 5*time.Second)
	app.Type("id:settings-search", "提示音")
	app.WaitFor("id:settings-hit-general-0", 5*time.Second)
	app.Press("id:settings-hit-general-0")
	app.WaitFor("id:sound-enabled", 5*time.Second)

	app.Press("id:sound-enabled")
	raw, err := os.ReadFile(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"soundEnabled": true`) {
		t.Fatalf("the switch did not reach the config:\n%s", raw)
	}

	// The volume slider and the sound rows are beside it.
	app.WaitFor("id:sound-volume", 5*time.Second)
	app.WaitFor("id:sound-import", 5*time.Second)
	app.WaitFor("id:sound-preview", 5*time.Second)
}
