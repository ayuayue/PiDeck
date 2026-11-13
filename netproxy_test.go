package main

// Checks the proxy settings: routing a request, the environment handed to
// an agent, and the settings fields saving.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestProxySettings(t *testing.T) {
	appProxy.set("http://127.0.0.1:7890", "localhost,127.0.0.1")
	defer appProxy.set("", "")
	req, _ := http.NewRequest("GET", "https://api.example.com/v1/models", nil)
	u, err := appProxy.proxyFunc(req)
	if err != nil || u == nil || u.Host != "127.0.0.1:7890" {
		t.Fatalf("proxy = %v, %v", u, err)
	}
	local, _ := http.NewRequest("GET", "http://localhost:8080/x", nil)
	if u, _ := appProxy.proxyFunc(local); u != nil {
		t.Fatalf("bypass = %v", u)
	}

	agentProxy.set("http://10.0.0.2:3128", "corp.local")
	defer agentProxy.set("", "")
	env := strings.Join(agentProxy.env(), " ")
	for _, want := range []string{"HTTPS_PROXY=http://10.0.0.2:3128", "ALL_PROXY=http://10.0.0.2:3128", "NO_PROXY=corp.local"} {
		if !strings.Contains(env, want) {
			t.Errorf("env lacks %q: %s", want, env)
		}
	}
	agentProxy.set("", "")
	if env := agentProxy.env(); len(env) != 0 {
		t.Fatalf("direct env = %v", env)
	}
}

func TestProviderProxy(t *testing.T) {
	var seen string
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.String()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer proxy.Close()
	appProxy.set(proxy.URL, "")
	defer appProxy.set("", "")
	status, body, err := providerRequest("GET", "http://api.example.com/models", "key", nil)
	if err != nil || status != http.StatusOK || !strings.Contains(string(body), "data") {
		t.Fatalf("request = %d %q %v", status, body, err)
	}
	if !strings.Contains(seen, "api.example.com/models") {
		t.Fatalf("proxy saw %q", seen)
	}
}

func TestProxySettingsUI(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Cleanup(func() {
		appProxy.set("", "")
		agentProxy.set("", "")
	})
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-env")
	app.WaitFor("id:proxy-app", 5*time.Second)
	app.Type("id:proxy-app", "http://127.0.0.1:7890")
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(filepath.Join(home, "config.json"))
		if err == nil && strings.Contains(string(raw), `"proxyApp": "http://127.0.0.1:7890"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("config = %s", raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
