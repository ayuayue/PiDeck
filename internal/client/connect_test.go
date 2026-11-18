package client

// Checks the phone API's auth and parsing, the session reading it serves,
// and the phone screen against a fake desktop.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
	qrcode "github.com/skip2/go-qrcode"
)

// TestMobileConnect drives the phone screen against a fake desktop.
func TestMobileConnect(t *testing.T) {
	const token = "phone-token"
	state := remotewire.Snapshot{Name: "PiDeck Lite", Version: "0.2.0", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{
			{ID: "s1", Title: "电脑上的会话", Status: "idle", Updated: time.Now().UnixMilli()},
		},
	}}}
	transcript := remotewire.Transcript{ID: "s1", Title: "电脑上的会话", Messages: []remotewire.Message{
		{Role: "user", Text: "手机能看到吗"},
		{Role: "thinking", Text: "用户在问手机端能不能看到会话内容。"},
		{Role: "tool", Text: "read src/app.ts"},
		{Role: "tool", Text: "edit src/app.ts"},
		{Role: "assistant", Text: "看到了，这是电脑上的会话。"},
	}}
	server := newTestHTTPServer(t, token, state, transcript)
	defer server.Close()

	t.Setenv("PIDECK_LITE_MOBILE", "1")
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-server", 10*time.Second)
	shot(app, "59-mobile-connect")
	app.Type("id:mobile-server", server.URL)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")
	waitApp(app, "text:电脑项目", 15*time.Second)
	shot(app, "60-mobile-home")
	// The projects and their sessions live in the drawer.
	openPhoneRail(app)
	app.WaitFor("id:mobile-session", 10*time.Second)
	shot(app, "60-mobile-rail")
	// A press can land while the list is still settling; try again.
	for i := 0; i < 3; i++ {
		app.Press("id:mobile-session")
		if waitQuiet(app, "text:看到了，这是电脑上的会话。", 5*time.Second) {
			break
		}
	}
	waitApp(app, "text:看到了，这是电脑上的会话。", 15*time.Second)
	shot(app, "61-mobile-transcript")
	// Tool calls fold into one row that opens in place.
	app.Press("id:mobile-tools")
	waitApp(app, "text:read src/app.ts", 5*time.Second)
	shot(app, "66-mobile-tools")
}

// newTestHTTPServer is the desktop the mobile test connects to.
func newTestHTTPServer(t *testing.T, token string, state remotewire.Snapshot, transcript remotewire.Transcript) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	check := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "PiDeck Lite", "host": "desk"})
		}
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(state)
		}
	})
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			if strings.HasSuffix(r.URL.Path, "/s1") {
				_ = json.NewEncoder(w).Encode(transcript)
				return
			}
			http.NotFound(w, r)
		}
	})
	return httptest.NewServer(mux)
}

// TestQRRoundTrip encodes a connection link and reads it back, the way the
// desktop shows a code and the phone scans it.
func TestQRRoundTrip(t *testing.T) {
	link := "http://10.0.2.2:8787/?token=abc123"
	if given := os.Getenv("PIDECK_QR_LINK"); given != "" {
		link = given
	}
	png, err := qrcode.Encode(link, qrcode.Medium, 256)
	if err != nil {
		t.Fatal(err)
	}
	if len(png) == 0 {
		t.Fatal("no QR image")
	}
	// PIDECK_QR_OUT writes the code to a file, for trying it on a device.
	if out := os.Getenv("PIDECK_QR_OUT"); out != "" {
		if err := os.WriteFile(out, png, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := decodeQRLink(png)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got != link {
		t.Fatalf("decoded %q, want %q", got, link)
	}
}

// TestRememberConnection keeps the newest server first, once each.
func TestRememberConnection(t *testing.T) {
	saved := rememberConnection(nil, mobileRecent{Server: "http://a", Token: "1", Name: "a"})
	if saved.Server != "http://a" || len(saved.Recent) != 1 {
		t.Fatalf("first = %+v", saved)
	}
	saved = rememberConnection(saved.Recent, mobileRecent{Server: "http://b", Token: "2", Name: "b"})
	if saved.Server != "http://b" || len(saved.Recent) != 2 || saved.Recent[0].Server != "http://b" {
		t.Fatalf("second = %+v", saved)
	}
	saved = rememberConnection(saved.Recent, mobileRecent{Server: "http://a", Token: "3", Name: "a2"})
	if len(saved.Recent) != 2 || saved.Recent[0].Name != "a2" {
		t.Fatalf("moved = %+v", saved)
	}
	for i := 0; i < 8; i++ {
		saved = rememberConnection(saved.Recent, mobileRecent{Server: "http://x" + strconv.Itoa(i), Name: "x"})
	}
	if len(saved.Recent) != 5 {
		t.Fatalf("capped at %d", len(saved.Recent))
	}
}

// TestMobileRecentConnections shows the servers the phone has used.
func TestMobileRecentConnections(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_MOBILE", "1")
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(mobileSaved{Recent: []mobileRecent{
		{Server: "http://10.0.2.2:8787", Token: "a", Name: "caoayu", At: 2},
		{Server: "http://100.64.0.8:8787", Token: "b", Name: "笔记本", At: 1},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "remote.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("text:最近连接", 5*time.Second)
	if got := len(app.Query("id:mobile-recent")); got != 2 {
		t.Fatalf("recent rows = %d, want 2", got)
	}
	app.Advance(300 * time.Millisecond)
	shot(app, "68-mobile-recent")
}

// TestMobileRecentAfterConnect lists the server the phone just used, without
// restarting: the saved link alone does not fill the list.
func TestMobileRecentAfterConnect(t *testing.T) {
	const token = "phone-token"
	state := remotewire.Snapshot{Name: "PiDeck Lite", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{{ID: "s1", Title: "电脑上的会话"}},
	}}}
	server := newTestHTTPServer(t, token, state, remotewire.Transcript{ID: "s1"})
	defer server.Close()

	home := t.TempDir()
	t.Setenv("PIDECK_LITE_MOBILE", "1")
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(mobileSaved{Server: server.URL, Token: token})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "remote.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	waitApp(app, "text:电脑项目", 15*time.Second)
	openPhoneRail(app)
	app.Press("id:mobile-settings")
	app.WaitFor("id:mobile-settings-sheet", 5*time.Second)
	app.Press("id:mobile-disconnect")
	app.WaitFor("text:最近连接", 5*time.Second)
	if got := len(app.Query("id:mobile-recent")); got != 1 {
		t.Fatalf("recent rows = %d, want 1", got)
	}
}

// TestMobileAsk answers the desktop's pending question from the phone.
func TestMobileAsk(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	const token = "phone-token"
	var mu sync.Mutex
	ask := &remotewire.Ask{Method: "confirm", Title: "允许运行 go test？", Message: "桌面在等你"}
	var answered map[string]any
	state := remotewire.Snapshot{Name: "PiDeck Lite", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{{ID: "s1", Title: "电脑上的会话"}},
	}}}
	check := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "PiDeck Lite", "host": "desk"})
		}
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(state)
		}
	})
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		mu.Lock()
		tr := remotewire.Transcript{ID: "s1", Title: "电脑上的会话", Ask: ask}
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(tr)
	})
	mux.HandleFunc("/api/sessions/s1/answer", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		answered, ask = body, nil
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	t.Setenv("PIDECK_LITE_MOBILE", "1")
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-server", 10*time.Second)
	app.Type("id:mobile-server", server.URL)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")
	waitApp(app, "text:电脑项目", 15*time.Second)
	openPhoneRail(app)
	app.WaitFor("id:mobile-session", 10*time.Second)
	// The press can land while the list settles; try again.
	for i := 0; i < 3; i++ {
		app.Press("id:mobile-session")
		if waitQuiet(app, "id:mobile-ask", 5*time.Second) {
			break
		}
	}
	waitApp(app, "id:mobile-ask", 15*time.Second)
	app.Press("id:mobile-ask-allow")
	deadline := time.Now().Add(10 * time.Second)
	for {
		mu.Lock()
		got := answered
		mu.Unlock()
		if got != nil && got["confirmed"] == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("answer = %+v", got)
		}
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
	app.WaitForGone("id:mobile-ask", 10*time.Second)
}
