//go:build !js && !android && !ios

package workbench

// Checks the phone's file browsing: the API's refusals, and the screen
// that lists and opens a project's files.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestFileWithin(t *testing.T) {
	root := t.TempDir()
	if _, ok := fileWithin(root, "note.txt"); !ok {
		t.Fatal("a plain name should resolve")
	}
	if _, ok := fileWithin(root, "src/app.go"); !ok {
		t.Fatal("a nested name should resolve")
	}
	for _, rel := range []string{"", ".", "..", "../x", "src/../../x", "a/../../x"} {
		if _, ok := fileWithin(root, rel); ok {
			t.Errorf("fileWithin(%q) resolved, want a refusal", rel)
		}
	}
}

// TestRemoteFiles drives the desktop's file endpoints against a real app.
func TestRemoteFiles(t *testing.T) {
	workspace := t.TempDir()
	write := func(rel, body string) {
		path := filepath.Join(workspace, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("note.txt", "hello phone")
	write("src/app.go", "package main")
	write("bin.dat", "he\x00llo")
	write("big.txt", strings.Repeat("x", remoteFileMax+1))

	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "FilesProject"}},
		Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	if built == nil || built.remote == nil {
		t.Fatal("the app did not build its remote host")
	}
	built.remote.mu.Lock()
	built.remote.token = "phone-token"
	built.remote.mu.Unlock()
	handler := built.remote.handler()
	call := func(path string) *httptest.ResponseRecorder {
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("Authorization", "Bearer phone-token")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			done <- rec
		}()
		deadline := time.Now().Add(10 * time.Second)
		for {
			select {
			case rec := <-done:
				return rec
			case <-time.After(2 * time.Millisecond):
				if time.Now().After(deadline) {
					t.Fatal("request timed out")
				}
				screen.Settle()
			}
		}
	}

	project := url.QueryEscape(workspace)
	rec := call("/api/files?project=" + project)
	if rec.Code != http.StatusOK {
		t.Fatalf("files = %d: %s", rec.Code, rec.Body.String())
	}
	var list struct {
		Files []remotewire.File `json:"files"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	paths := map[string]bool{}
	for _, f := range list.Files {
		paths[f.Path] = true
	}
	if !paths["note.txt"] || !paths["src/app.go"] {
		t.Fatalf("files = %+v", list.Files)
	}

	rec = call("/api/file?project=" + project + "&path=" + url.QueryEscape("src/app.go"))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "package main") {
		t.Fatalf("file = %d: %s", rec.Code, rec.Body.String())
	}
	cases := []struct {
		path string
		code int
	}{
		{"/api/file?project=" + project + "&path=" + url.QueryEscape("../x"), http.StatusBadRequest},
		{"/api/file?project=" + project + "&path=missing.txt", http.StatusNotFound},
		{"/api/file?project=" + project + "&path=bin.dat", http.StatusUnsupportedMediaType},
		{"/api/file?project=" + project + "&path=big.txt", http.StatusRequestEntityTooLarge},
		{"/api/files?project=" + url.QueryEscape(filepath.Join(workspace, "nope")), http.StatusNotFound},
	}
	for _, c := range cases {
		if rec := call(c.path); rec.Code != c.code {
			t.Errorf("%s = %d, want %d: %s", c.path, rec.Code, c.code, rec.Body.String())
		}
	}
}
