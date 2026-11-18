//go:build !js && !android && !ios

package workbench

// Checks the prompt store's index and one-click imports.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestPromptIndex(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	body = `{"packs":[{"id":"a","name":"A","url":"https://x/a.json"},{"id":"","name":"bad","url":"https://x"}]}`
	list, err := fetchPromptIndex(srv.URL)
	if err != nil || len(list) != 1 || list[0].ID != "a" {
		t.Fatalf("object = %+v, %v", list, err)
	}
	body = `[{"id":"b","name":"B","url":"https://x/b.json"}]`
	list, err = fetchPromptIndex(srv.URL)
	if err != nil || len(list) != 1 || list[0].ID != "b" {
		t.Fatalf("array = %+v, %v", list, err)
	}
	if _, err := fetchPromptIndex("ftp://x"); err == nil {
		t.Fatal("a non-http index should fail")
	}
}

func TestInstallPromptIndexEntry(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	a.cfg = st.config()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"name":"团队","prompts":[{"title":"梳理改动","body":"看看改动","category":"评审"}]}`))
	}))
	defer srv.Close()
	added, skipped, err := a.installPromptIndexEntry(promptIndexEntry{ID: "team", URL: srv.URL})
	if err != nil || added != 1 || skipped != 0 {
		t.Fatalf("import = %d/%d, %v", added, skipped, err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "prompts", "user.json"))
	if err != nil || !strings.Contains(string(raw), "梳理改动") {
		t.Fatalf("user.json = %s, %v", raw, err)
	}
}

func TestPromptStoreUI(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.json":
			_, _ = w.Write([]byte(`{"packs":[{"id":"team","name":"团队提示词","url":"` + srvURL + `/pack.json"}]}`))
		case "/pack.json":
			_, _ = w.Write([]byte(`{"prompts":[{"title":"商店导入测试","body":"正文","category":"导入"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("id:rail-palette")
	app.Type("label:命令", "提示词库")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option")) > 0 })
	app.Press("role:option >> nth=0")
	app.WaitFor("id:prompt-store-open", 5*time.Second)
	app.Press("id:prompt-store-open")
	app.WaitFor("id:prompt-store", 5*time.Second)
	app.Type("id:prompt-store-url", srv.URL+"/index.json")
	app.Press("id:prompt-store-load")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:prompt-store-entry-team")) > 0 })
	app.Press("id:prompt-store-install-team")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("text:已导入")) > 0 })
	app.Press("id:prompt-store-close")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("text:商店导入测试")) > 0 })
}
