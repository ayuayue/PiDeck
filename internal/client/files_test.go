package client

// Checks the phone's file browsing: the API's refusals, and the screen
// that lists and opens a project's files.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestMobileFiles browses a project's files from the phone.
func TestMobileFiles(t *testing.T) {
	const token = "phone-token"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		switch {
		case r.URL.Path == "/api/ping":
			reply(map[string]any{"name": "PiDeck", "host": "desk"})
		case r.URL.Path == "/api/state":
			reply(remotewire.Snapshot{Name: "PiDeck", Projects: []remotewire.Project{{
				Path: "/tmp/project", Name: "电脑项目",
				Sessions: []remotewire.Session{{ID: "s1", Title: "会话一", Status: "idle", Updated: time.Now().UnixMilli()}},
			}}})
		case r.URL.Path == "/api/files":
			reply(map[string]any{"files": []remotewire.File{
				{Path: "note.txt", Size: 12}, {Path: "src/app.go", Size: 1200},
			}})
		case r.URL.Path == "/api/file":
			if r.URL.Query().Get("path") != "src/app.go" {
				http.NotFound(w, r)
				return
			}
			reply(map[string]any{"path": "src/app.go", "text": "package main\n\nfunc main() {\n}\n", "size": 33})
		case r.URL.Path == "/api/session/s1":
			reply(remotewire.Transcript{ID: "s1", Title: "会话一"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-server", 10*time.Second)
	app.Type("id:mobile-server", server.URL)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")
	waitApp(app, "text:电脑项目", 15*time.Second)
	openPhoneRail(app)
	app.Press("id:mobile-session >> nth=0")
	waitApp(app, "id:mobile-files", 15*time.Second)
	app.Press("id:mobile-files")
	waitApp(app, "id:mobile-file >> nth=0", 15*time.Second)
	app.Type("id:mobile-files-filter", "app")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:mobile-file")) == 1 })
	app.Press("id:mobile-file >> nth=0")
	waitApp(app, "id:mobile-file-view", 10*time.Second)
	app.WaitFor("text:package main\n\nfunc main() {\n}\n", 10*time.Second)

	// The find field keeps only the matching lines.
	app.Type("id:mobile-file-find", "func")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:mobile-file-line")) == 1 })
	app.WaitFor("text:1 行匹配", 5*time.Second)
	app.Clear("id:mobile-file-find")
	app.Type("id:mobile-file-find", "zzz")
	app.WaitFor("text:没有匹配的行", 5*time.Second)
}
