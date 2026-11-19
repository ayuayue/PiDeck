package client

// The phone's alert is its own setting: the sheet's switch reaches
// remote.json, and choosing a sound lists the built-ins.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileSoundSettings(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_MOBILE", "1")
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_LANG", "zh-CN")
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.WaitFor("id:mobile-server", 10*time.Second)
	app.Type("id:mobile-server", desk.server.URL)
	app.Type("id:mobile-token", desk.token)
	app.Press("id:mobile-connect")
	waitApp(app, "id:mobile-draft", 15*time.Second)

	app.Press("id:mobile-settings")
	waitApp(app, "id:mobile-settings-sheet", 5*time.Second)
	app.Press("id:mobile-sound")
	waitApp(app, "id:mobile-sound-name", 5*time.Second)

	raw, err := os.ReadFile(filepath.Join(home, "remote.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"sound":true`) {
		t.Fatalf("the switch did not reach remote.json:\n%s", raw)
	}

	// Picking one of the built-ins is kept too.
	app.Press("id:mobile-sound-name >> nth=2")
	raw, err = os.ReadFile(filepath.Join(home, "remote.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"soundName":"bell"`) {
		t.Fatalf("the chosen sound did not reach remote.json:\n%s", raw)
	}
}
