//go:build !js && !android && !ios

package workbench

// Checks the daily heartbeat: what it carries, when it stays home, and
// that it never takes a path, a name or a credential with it.

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// telemetryTestOptions is one heartbeat's inputs with the network replaced.
func telemetryTestOptions(t *testing.T, post func(url string, body []byte) error) telemetrySendOptions {
	t.Helper()
	on := true
	return telemetrySendOptions{
		ProjectKey: "test-key",
		Host:       "https://ph.example/",
		Now:        time.Date(2026, 3, 4, 23, 30, 0, 0, time.Local),
		Settings:   config{TelemetryEnabled: &on},
		Meta:       telemetryMeta{Version: "0.2.0", Platform: "windows", Arch: "amd64"},
		Snapshot:   collectTelemetrySnapshot(telemetrySnapshotInput{Language: apptext.LangEnUS, Theme: "system", SessionsTotal: 4, ProjectsTotal: 2}),
		Post:       post,
	}
}

func TestTelemetryHeartbeat(t *testing.T) {
	var gotURL string
	var got map[string]any
	opts := telemetryTestOptions(t, func(url string, body []byte) error {
		gotURL = url
		return json.Unmarshal(body, &got)
	})
	opts.Settings.TelemetryInstallID = "known-install"

	installID, day, sent, err := sendTelemetryHeartbeat(opts)
	if err != nil {
		t.Fatal(err)
	}
	if !sent || installID != "known-install" || day != "2026-03-04" {
		t.Fatalf("sent=%v install=%q day=%q", sent, installID, day)
	}
	if gotURL != "https://ph.example/capture/" {
		t.Fatalf("url = %q", gotURL)
	}
	if got["api_key"] != "test-key" || got["event"] != telemetryEvent || got["distinct_id"] != "known-install" {
		t.Fatalf("body = %v", got)
	}
	props, ok := got["properties"].(map[string]any)
	if !ok {
		t.Fatalf("properties = %v", got["properties"])
	}
	for key, want := range map[string]any{
		"app":            "pideck-v2",
		"app_name":       "PiDeck V2",
		"app_version":    "0.2.0",
		"platform":       "windows",
		"arch":           "amd64",
		"install_id":     "known-install",
		"sessions_total": float64(4),
		"projects_total": float64(2),
	} {
		if props[key] != want {
			t.Errorf("properties[%q] = %v, want %v", key, props[key], want)
		}
	}
	set, ok := props["$set"].(map[string]any)
	if !ok {
		t.Fatalf("$set = %v", props["$set"])
	}
	if set["app"] != "pideck-v2" || set["app_version"] != "0.2.0" {
		t.Fatalf("$set = %v", set)
	}
}

func TestTelemetryHeartbeatSkips(t *testing.T) {
	off := false
	cases := []struct {
		name   string
		mutate func(*telemetrySendOptions)
	}{
		{"development build", func(o *telemetrySendOptions) { o.Development = true }},
		{"switched off", func(o *telemetrySendOptions) { o.Settings.TelemetryEnabled = &off }},
		{"already sent today", func(o *telemetrySendOptions) { o.Settings.TelemetryLastHeartbeatDate = telemetryDay(o.Now) }},
		{"no project key", func(o *telemetrySendOptions) { o.ProjectKey = "  " }},
		{"no host", func(o *telemetrySendOptions) { o.Host = " / " }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			posted := false
			opts := telemetryTestOptions(t, func(string, []byte) error {
				posted = true
				return nil
			})
			c.mutate(&opts)
			installID, day, sent, err := sendTelemetryHeartbeat(opts)
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if sent || posted || installID != "" || day != "" {
				t.Fatalf("sent=%v posted=%v install=%q day=%q", sent, posted, installID, day)
			}
		})
	}
}

func TestTelemetryFailureKeepsDay(t *testing.T) {
	opts := telemetryTestOptions(t, func(string, []byte) error { return errors.New("offline") })
	installID, day, sent, err := sendTelemetryHeartbeat(opts)
	if err == nil || sent || installID != "" || day != "" {
		t.Fatalf("err=%v sent=%v install=%q day=%q", err, sent, installID, day)
	}
}

func TestTelemetryInstallID(t *testing.T) {
	first, err := newTelemetryInstallID()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newTelemetryInstallID()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 32 || first == second {
		t.Fatalf("ids = %q and %q", first, second)
	}
	if _, err := hex.DecodeString(first); err != nil {
		t.Fatalf("id %q is not hex: %v", first, err)
	}
}

func TestTelemetryPayloadFixedFields(t *testing.T) {
	payload := telemetryPayload("key", telemetryMeta{Version: "0.2.0", Platform: "linux", Arch: "arm64"},
		map[string]any{"app": "someone-else", "app_version": "9.9.9"}, "id")
	props := payload["properties"].(map[string]any)
	if props["app"] != "pideck-v2" || props["app_version"] != "0.2.0" {
		t.Fatalf("properties = %v", props)
	}
	set := props["$set"].(map[string]any)
	if set["app"] != "pideck-v2" {
		t.Fatalf("$set = %v", set)
	}
}

func TestTelemetryCarriesNoPrivateData(t *testing.T) {
	opts := telemetryTestOptions(t, func(string, []byte) error { return nil })
	on := true
	opts.Settings = config{
		TelemetryEnabled: &on,
		Workspaces:       []workspaceCfg{{Path: "/home/secret/project-alpha", Name: "secret-project"}},
		Titles:           map[string]string{"s1": "confidential-title"},
		FeishuWebhook:    "https://hooks.example/secret-webhook",
		ProxyApp:         "http://user:s3cret-pass@127.0.0.1:7890",
		ImageModel:       "secret-model",
		RecentFiles:      []string{"/home/secret/file.go"},
	}
	var body []byte
	opts.Post = func(_ string, b []byte) error {
		body = b
		return nil
	}
	if _, _, sent, err := sendTelemetryHeartbeat(opts); err != nil || !sent {
		t.Fatalf("sent=%v err=%v", sent, err)
	}
	text := string(body)
	for _, secret := range []string{"secret-project", "confidential-title", "secret-webhook", "s3cret-pass", "/home/secret", "secret-model", "file.go"} {
		if strings.Contains(text, secret) {
			t.Errorf("heartbeat carries %q:\n%s", secret, text)
		}
	}
}

func TestTelemetrySettingPersists(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !telemetryEnabled(st.config()) {
		t.Fatal("a fresh config should report usage stats")
	}
	off := false
	st.edit(func(c *config) {
		c.TelemetryEnabled = &off
		c.TelemetryInstallID = "install-1"
		c.TelemetryLastHeartbeatDate = "2026-03-04"
	})
	st2, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := st2.config()
	if telemetryEnabled(cfg) {
		t.Fatal("the switch did not persist")
	}
	if cfg.TelemetryInstallID != "install-1" || cfg.TelemetryLastHeartbeatDate != "2026-03-04" {
		t.Fatalf("install=%q day=%q", cfg.TelemetryInstallID, cfg.TelemetryLastHeartbeatDate)
	}
}

func TestTelemetrySnapshotCounts(t *testing.T) {
	a := &app{
		cfg: config{Theme: "dark", Workspaces: []workspaceCfg{{Path: "/a"}, {Path: "/b"}},
			PetEnabled: true, RemoteEnabled: true, FeishuEnabled: true, NotifyOnDone: true,
			ScanPi: true, ProxyApp: "http://127.0.0.1:7890", BackgroundImage: "/tmp/bg.png"},
		all: make([]*session, 3),
	}
	snap := a.telemetrySnapshot(12)
	want := map[string]any{
		"theme":              "dark",
		"sessions_total":     3,
		"projects_total":     2,
		"feature_pet":        false,
		"feature_remote":     true,
		"feature_feishu":     true,
		"feature_notify":     true,
		"feature_scan_pi":    true,
		"feature_proxy":      true,
		"feature_background": true,
	}
	for key, value := range want {
		if snap[key] != value {
			t.Errorf("%s = %v, want %v", key, snap[key], value)
		}
	}
	if _, ok := snap["telemetryEnabled"]; ok {
		t.Error("the snapshot should not carry the switch itself")
	}
}

// TestTelemetrySwitch checks the switch is in the settings page and that
// turning it off reaches config.json.
func TestTelemetrySwitch(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-general")
	app.WaitFor("id:telemetry-enabled", 5*time.Second)
	app.Press("id:telemetry-enabled")
	deadline := time.Now().Add(5 * time.Second)
	var raw []byte
	for {
		raw, _ = os.ReadFile(filepath.Join(home, "config.json"))
		if strings.Contains(string(raw), `"telemetryEnabled": false`) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("config.json did not record the switch: %s", raw)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
