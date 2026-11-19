//go:build !js && !android && !ios

package workbench

// The review API's refusals: a request with no item, a project the
// desktop does not know, and a comment with nothing in it. These reach no
// network, so they run without gh being logged in.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestRemoteReviewRefusals(t *testing.T) {
	workspace := t.TempDir()
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "ReviewProject"}},
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
	call := func(method, path string, body any) *httptest.ResponseRecorder {
		payload, _ := json.Marshal(body)
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			var reader *bytes.Reader
			if body == nil {
				reader = bytes.NewReader(nil)
			} else {
				reader = bytes.NewReader(payload)
			}
			req := httptest.NewRequest(method, path, reader)
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
	unknown := url.QueryEscape(filepath.Join(workspace, "nope"))

	cases := []struct {
		name   string
		method string
		path   string
		body   any
		code   int
	}{
		{"list refuses a write", http.MethodPost, "/api/review?project=" + project, nil, http.StatusMethodNotAllowed},
		{"detail needs a number", http.MethodGet, "/api/review/detail?project=" + project + "&kind=pr", nil, http.StatusBadRequest},
		{"detail needs a known project", http.MethodGet,
			"/api/review/detail?project=" + unknown + "&kind=pr&number=1", nil, http.StatusNotFound},
		{"list needs a known project", http.MethodGet, "/api/review?project=" + unknown, nil, http.StatusNotFound},
		{"action needs a number", http.MethodPost, "/api/review/action",
			map[string]any{"project": workspace, "kind": "pr", "action": "comment", "body": "hi"}, http.StatusBadRequest},
		{"empty comment is refused", http.MethodPost, "/api/review/action",
			map[string]any{"project": workspace, "kind": "pr", "number": 3, "action": "comment", "body": "  "}, http.StatusBadRequest},
		{"action needs a known project", http.MethodPost, "/api/review/action",
			map[string]any{"project": filepath.Join(workspace, "nope"), "number": 3, "action": "merge"}, http.StatusNotFound},
		{"evaluate needs a number", http.MethodPost, "/api/review/evaluate",
			map[string]any{"project": workspace, "kind": "pr"}, http.StatusBadRequest},
		{"a request-changes review needs a note", http.MethodPost, "/api/review/action",
			map[string]any{"project": workspace, "kind": "pr", "number": 3, "action": "review", "method": "request-changes"}, http.StatusBadRequest},
		{"diff needs a number", http.MethodGet, "/api/review/diff?project=" + project + "&kind=pr", nil, http.StatusBadRequest},
		{"diff needs a known project", http.MethodGet,
			"/api/review/diff?project=" + unknown + "&kind=pr&number=1", nil, http.StatusNotFound},
		{"an issue has no patch", http.MethodGet,
			"/api/review/diff?project=" + project + "&kind=issue&number=1", nil, http.StatusBadRequest},
		{"diff refuses a write", http.MethodPost, "/api/review/diff?project=" + project + "&kind=pr&number=1", nil, http.StatusMethodNotAllowed},
	}
	for _, c := range cases {
		rec := call(c.method, c.path, c.body)
		if rec.Code != c.code {
			t.Errorf("%s = %d, want %d: %s", c.name, rec.Code, c.code, rec.Body.String())
		}
	}
}
