package main

// Checks the support bundle: what it contains and that secrets are gone.

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestDiagnosticBundle(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) {
		c.RemoteToken = "super-secret"
		c.FeishuSecret = "feishu-secret"
		c.FeishuWebhook = "https://open.feishu.cn/open-apis/bot/v2/hook/abc"
		c.ProxyApp = "http://user:pass@127.0.0.1:7890/path?token=xyz"
		c.PluginSettings = map[string]string{"p/apiKey": "k", "p/lang": "zh"}
	})
	logPath := filepath.Join(dir, "logs", "app.log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath, []byte("line1\nline2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &app{st: st, diagPath: logPath, startedAt: time.Now()}
	a.cfg = st.config()
	data, err := a.diagnosticZip()
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(rc)
		rc.Close()
		files[f.Name] = string(body)
	}
	for _, name := range []string{"report.txt", "config.json", "plugins.txt", "app.log", "README.txt"} {
		if _, ok := files[name]; !ok {
			t.Errorf("bundle lacks %s", name)
		}
	}
	cfg := files["config.json"]
	for _, secret := range []string{"super-secret", "feishu-secret", "hook/abc", "user:pass", "token=xyz"} {
		if strings.Contains(cfg, secret) {
			t.Errorf("config still has %q:\n%s", secret, cfg)
		}
	}
	if !strings.Contains(cfg, `"remoteToken": "***"`) || !strings.Contains(cfg, `"p/apiKey": "***"`) {
		t.Errorf("secrets were not redacted:\n%s", cfg)
	}
	if !strings.Contains(cfg, `"p/lang": "zh"`) {
		t.Errorf("a harmless setting was redacted:\n%s", cfg)
	}
	if files["app.log"] != "line1\nline2\n" {
		t.Errorf("log = %q", files["app.log"])
	}
	if !strings.Contains(files["plugins.txt"], "没有插件") {
		t.Errorf("plugins = %q", files["plugins.txt"])
	}
}

func TestDiagnosticsBundleUI(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-diagnostics")
	app.WaitFor("id:diag-bundle", 5*time.Second)
	app.Press("id:diag-bundle")
	deadline := time.Now().Add(5 * time.Second)
	for {
		files, _ := filepath.Glob(filepath.Join(home, "exports", "diagnostics-*.zip"))
		if len(files) > 0 {
			zr, err := zip.OpenReader(files[0])
			if err != nil {
				t.Fatalf("zip: %v", err)
			}
			names := map[string]bool{}
			for _, f := range zr.File {
				names[f.Name] = true
			}
			zr.Close()
			if !names["report.txt"] || !names["config.json"] {
				t.Fatalf("bundle entries = %v", names)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no diagnostics bundle was written")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
