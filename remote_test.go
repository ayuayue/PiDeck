package main

// Checks the phone API's auth and parsing, the session reading it serves,
// and the phone screen against a fake desktop.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

// TestRemoteAuth checks bearer and query tokens, including refusals.
func TestRemoteAuth(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "http://x/api/state", nil)
	req.Header.Set("Authorization", "Bearer secret")
	if !remoteAuthorized(req, "secret") {
		t.Fatal("bearer token refused")
	}
	if remoteAuthorized(req, "other") {
		t.Fatal("wrong token accepted")
	}
	req, _ = http.NewRequest(http.MethodGet, "http://x/api/state?token=secret", nil)
	if !remoteAuthorized(req, "secret") {
		t.Fatal("query token refused for a GET")
	}
	req, _ = http.NewRequest(http.MethodPost, "http://x/api/state?token=secret", nil)
	if remoteAuthorized(req, "secret") {
		t.Fatal("query token accepted for a POST")
	}
}

// TestRemoteParsers checks the small pieces the network cards rely on.
func TestRemoteParsers(t *testing.T) {
	if got := normalizeIPv4("10.144.1.2/24"); got != "10.144.1.2" {
		t.Fatalf("normalizeIPv4 = %q", got)
	}
	if got := normalizeIPv4("999.1.1.1"); got != "" {
		t.Fatalf("bad address = %q", got)
	}
	ch, ok := easyTierJSON([]byte(`{"result":{"ipv4_addr":"10.144.1.2/24","hostname":"desk","version":"2.4"}}`))
	if !ok || ch.Address != "10.144.1.2" || !ch.Ready {
		t.Fatalf("easyTierJSON = %+v, %v", ch, ok)
	}
	ch, ok = easyTierTable("| Hostname | desk |\n| Virtual IP | 10.144.1.3/24 |\n")
	if !ok || ch.Address != "10.144.1.3" {
		t.Fatalf("easyTierTable = %+v, %v", ch, ok)
	}
}

// TestRemoteSessionReading reads a pi session file into the phone's
// messages.
func TestRemoteSessionReading(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "remote.jsonl")
	body := `{"type":"session","version":3,"id":"remote-1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"` + filepath.ToSlash(dir) + `"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":"电脑上的问题","timestamp":1767323046000}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"assistant","content":[{"type":"text","text":"电脑上的回答"}],"timestamp":1767323047000}}
`
	if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	turns, err := readSessionTurns(file)
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 1 || turns[0].Prompt != "电脑上的问题" {
		t.Fatalf("turns = %+v", turns)
	}
	messages := remoteMessages(turns)
	if len(messages) != 2 || messages[0].Role != "user" || messages[1].Text != "电脑上的回答" {
		t.Fatalf("messages = %+v", messages)
	}
}

// TestMobileConnect drives the phone screen against a fake desktop.
func TestMobileConnect(t *testing.T) {
	const token = "phone-token"
	state := remoteWireSnapshot{Name: "PiDeck Lite", Version: "0.2.0", Host: "desk", Projects: []remoteWireProject{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remoteWireSession{
			{ID: "s1", Title: "电脑上的会话", Status: "idle", Updated: time.Now().UnixMilli()},
		},
	}}}
	transcript := remoteWireTranscript{ID: "s1", Title: "电脑上的会话", Messages: []remoteWireMessage{
		{Role: "user", Text: "手机能看到吗"},
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
	app.WaitFor("id:mobile-session", 10*time.Second)
	shot(app, "60-mobile-sessions")
	app.Press("id:mobile-session")
	waitApp(app, "text:看到了，这是电脑上的会话。", 15*time.Second)
	shot(app, "61-mobile-transcript")
}

// newTestHTTPServer is the desktop the mobile test connects to.
func newTestHTTPServer(t *testing.T, token string, state remoteWireSnapshot, transcript remoteWireTranscript) *httptest.Server {
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

// TestRemoteSettings shows the desktop's remote section.
func TestRemoteSettings(t *testing.T) {
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-remote", 5*time.Second)
	app.Press("id:settings-tab-remote")
	app.WaitFor("text:连接方式", 5*time.Second)
	app.Advance(500 * time.Millisecond)
	shot(app, "62-remote-settings")
}
