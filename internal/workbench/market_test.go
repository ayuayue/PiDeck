//go:build !js && !android && !ios

package workbench

// Checks the plugin market's index and one-click installs.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestPluginIndex(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/404" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	body = `{"plugins":[{"id":"a","name":"A","url":"https://x/a.json"},{"id":"","name":"bad","url":"https://x"}]}`
	list, err := fetchPluginIndex(context.Background(), srv.URL)
	if err != nil || len(list) != 1 || list[0].ID != "a" {
		t.Fatalf("object = %+v, %v", list, err)
	}
	body = `[{"id":"b","name":"B","url":"https://x/b.json"}]`
	list, err = fetchPluginIndex(context.Background(), srv.URL)
	if err != nil || len(list) != 1 || list[0].ID != "b" {
		t.Fatalf("array = %+v, %v", list, err)
	}
	if _, err := fetchPluginIndex(context.Background(), "ftp://x"); err == nil {
		t.Fatal("a non-http index should fail")
	}
	if _, err := fetchPluginIndex(context.Background(), srv.URL+"/404"); err == nil {
		t.Fatal("a 404 index should fail")
	}
}

func TestInstallMarketPlugin(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	a.cfg = st.config()
	manifest := `{"id":"team","name":"团队插件","version":"1.0.0","contributes":{"commands":[{"id":"go","title":"走","action":{"type":"prompt","prompt":"x"}}]}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/team.json":
			_, _ = w.Write([]byte(manifest))
		case "/other.json":
			_, _ = w.Write([]byte(`{"id":"other","name":"Other","contributes":{"commands":[{"id":"x","title":"X","action":{"type":"prompt","prompt":"x"}}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	entry := marketEntry{ID: "team", Name: "团队插件", URL: srv.URL + "/team.json"}
	if _, err := a.installMarketPlugin(entry); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "plugins", "team.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("installed file: %v", err)
	}
	list := a.loadPlugins(nil)
	if len(list) != 1 || list[0].ID != "team" || len(list[0].Commands) != 1 {
		t.Fatalf("plugins = %+v", list)
	}
	if _, err := a.installMarketPlugin(entry); err == nil || !strings.Contains(err.Error(), "已经安装") {
		t.Fatalf("duplicate = %v", err)
	}
	if _, err := a.installMarketPlugin(marketEntry{ID: "team", Name: "X", URL: srv.URL + "/other.json"}); err == nil {
		t.Fatal("a mismatched manifest id should fail")
	}
}

func TestPluginMarketUI(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	manifest := `{"id":"team","name":"团队插件","version":"1.0.0","contributes":{"commands":[{"id":"go","title":"走","action":{"type":"prompt","prompt":"x"}}]}}`
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.json":
			_, _ = w.Write([]byte(`{"plugins":[{"id":"team","name":"团队插件","url":"` + srvURL + `/team.json"}]}`))
		case "/team.json":
			_, _ = w.Write([]byte(manifest))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	app := openApp(t, workspace, 1280, 860)
	app.Press("label:设置")
	app.Press("id:settings-tab-addons")
	app.WaitFor("id:plugin-market-open", 5*time.Second)
	app.Press("id:plugin-market-open")
	app.WaitFor("id:plugin-market", 5*time.Second)
	typeAll(t, app, "id:market-url", srv.URL+"/index.json")
	for i := 0; i < 4; i++ {
		if len(app.Query("id:market-entry-team")) > 0 {
			break
		}
		app.Press("id:market-load")
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	app.WaitUntil(30*time.Second, func() bool { return len(app.Query("id:market-entry-team")) > 0 })
	for i := 0; i < 4; i++ {
		if len(app.Query("text:已安装 v1.0.0")) > 0 {
			break
		}
		if len(app.Query("id:market-install-team")) > 0 && app.Enabled("id:market-install-team") {
			app.Press("id:market-install-team")
		}
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	app.WaitUntil(30*time.Second, func() bool { return len(app.Query("text:已安装 v1.0.0")) > 0 })
	app.WaitFor("id:market-close", 5*time.Second)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(home, "plugins", "team.json")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the plugin was not installed")
		}
		time.Sleep(50 * time.Millisecond)
	}
	app.Press("id:market-close")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("text:团队插件")) > 0 })
}
