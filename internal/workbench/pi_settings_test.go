//go:build !js && !android && !ios

package workbench

// Checks pi's settings round-trip and the controls in the models page.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestPiSettingsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_PI_CONFIG", dir)
	path := filepath.Join(dir, "settings.json")
	body := `{"unknown":{"x":1},"retry":{"enabled":true,"maxRetries":3,"provider":{"maxRetries":2}},
		"compaction":{"enabled":false,"reserveTokens":1000}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := readPiSettings()
	if err != nil || !s.Loaded || !s.RetryEnabled || s.RetryMax != 3 || s.CompactionEnabled || s.ReserveTokens != 1000 {
		t.Fatalf("read = %+v, %v", s, err)
	}
	s.HideThinking = true
	s.QuietStartup = true
	s.DefaultThinking = "high"
	s.RetryMax = 9
	s.CompactionEnabled = true
	s.KeepRecentTokens = 500
	if err := savePiSettings(s); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var root map[string]any
	if json.Unmarshal(raw, &root) != nil {
		t.Fatalf("file = %s", raw)
	}
	if root["unknown"] == nil || root["hideThinkingBlock"] != true || root["defaultThinkingLevel"] != "high" {
		t.Fatalf("root = %v", root)
	}
	retry, _ := root["retry"].(map[string]any)
	if retry["maxRetries"] != float64(9) || retry["provider"] == nil {
		t.Fatalf("retry = %v", retry)
	}
	compaction, _ := root["compaction"].(map[string]any)
	if compaction["enabled"] != true || compaction["keepRecentTokens"] != float64(500) {
		t.Fatalf("compaction = %v", compaction)
	}
}

func TestPiSettingsControls(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	cfgDir := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", cfgDir)
	path := filepath.Join(cfgDir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"quietStartup":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-pi")
	app.WaitFor("id:pi-hide-thinking", 5*time.Second)
	app.Press("id:pi-hide-thinking")
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(raw), `"hideThinkingBlock": true`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("settings.json = %s, %v", raw, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	app.Type("id:pi-retry-max", "7")
	app.Submit("id:pi-retry-max")
	// Submission schedules the file write after the input event. Keep
	// settling while the filesystem catches up, as target tests do.
	app.Settle()
	deadline = time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(raw), `"maxRetries": 7`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("settings.json after retries = %s, %v", raw, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
