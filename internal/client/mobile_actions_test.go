package client

// Drives the phone's own actions — new session, send, rename — against a
// fake desktop that records what it was asked to do.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/pideck-v2/internal/appinfo"
	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileSessionActions(t *testing.T) {
	const token = "phone-token"
	var mu sync.Mutex
	state := remotewire.Snapshot{Name: "PiDeck V2", Version: appinfo.Version, Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{
			{ID: "s1", Title: "电脑上的会话", Status: "idle", Updated: time.Now().UnixMilli(),
				Tokens: 1234, Context: 1234, ContextWindow: 128000, Cost: 0.02},
		},
	}}}
	var prompted, renamed []string
	pinned := false

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		switch {
		case r.URL.Path == "/api/ping":
			reply(map[string]any{"name": "PiDeck V2", "host": "desk"})
		case r.URL.Path == "/api/state":
			reply(state)
		case r.URL.Path == "/api/sessions" && r.Method == http.MethodPost:
			state.Projects[0].Sessions = append([]remotewire.Session{{ID: "s2", Title: "新会话", Status: "idle", Updated: time.Now().UnixMilli()}},
				state.Projects[0].Sessions...)
			reply(map[string]string{"id": "s2", "title": "新会话"})
		case strings.HasSuffix(r.URL.Path, "/prompt"):
			var body struct {
				Text string `json:"text"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			prompted = append(prompted, body.Text)
			reply(map[string]any{"ok": true})
		case strings.HasSuffix(r.URL.Path, "/rename"):
			var body struct {
				Title string `json:"title"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			renamed = append(renamed, body.Title)
			for i := range state.Projects[0].Sessions {
				if state.Projects[0].Sessions[i].ID == "s1" {
					state.Projects[0].Sessions[i].Title = body.Title
				}
			}
			reply(map[string]any{"ok": true})
		case strings.HasSuffix(r.URL.Path, "/pin"):
			pinned = true
			reply(map[string]any{"ok": true})
		case strings.HasPrefix(r.URL.Path, "/api/session/"):
			id := strings.TrimPrefix(r.URL.Path, "/api/session/")
			title := "新会话"
			if id == "s1" {
				title = "电脑上的会话"
			}
			reply(remotewire.Transcript{ID: id, Title: title})
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

	// Search narrows the titles and the messages.
	openPhoneRail(app)
	app.Press("id:mobile-search")
	app.Type("id:mobile-search-input", "电脑")
	app.Advance(300 * time.Millisecond)
	shot(app, "65-mobile-search")
	app.WaitFor("id:mobile-session >> nth=0", 5*time.Second)
	app.Press("id:mobile-search-close")

	// A new session starts on the new-session page, with its composer.
	openPhoneRail(app)
	app.Press("id:mobile-new")
	waitApp(app, "id:mobile-draft", 10*time.Second)
	app.Type("id:mobile-draft", "手机发来的第一条")
	app.Press("id:mobile-send")
	waitFor(t, app, 10*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(prompted) == 1 && prompted[0] == "手机发来的第一条"
	})

	// Back to the rail, then rename through the action sheet.
	openPhoneRail(app)
	waitApp(app, "id:mobile-session >> nth=0", 10*time.Second)
	app.Press("id:mobile-session-actions >> nth=0")
	waitApp(app, "id:mobile-act-rename", 5*time.Second)
	app.Advance(300 * time.Millisecond)
	shot(app, "64-mobile-sheet")
	app.Press("id:mobile-act-rename")
	app.WaitFor("id:mobile-rename-input", 5*time.Second)
	app.Clear("id:mobile-rename-input")
	app.Type("id:mobile-rename-input", "手机改的名字")
	app.Press("id:mobile-rename-save")
	waitFor(t, app, 10*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(renamed) == 1 && renamed[0] == "手机改的名字"
	})

	// Pin goes through the same sheet, once the rename sheet has gone.
	app.Advance(400 * time.Millisecond)
	for i := 0; i < 4; i++ {
		app.Press("id:mobile-session-actions >> nth=0")
		if waitQuiet(app, "id:mobile-act-pin", 2*time.Second) {
			break
		}
		app.Advance(200 * time.Millisecond)
	}
	app.Press("id:mobile-act-pin")
	waitFor(t, app, 10*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return pinned
	})
	app.Advance(300 * time.Millisecond)
	shot(app, "63-mobile-actions")
}

// waitFor polls cond while pumping the app's clock and frames.
func waitFor(t *testing.T, app *nsgotest.App, limit time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for {
		if cond() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		app.Advance(20 * time.Millisecond)
	}
}
