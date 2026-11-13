package main

// Checks the phone API's auth and parsing, the session reading it serves,
// and the phone screen against a fake desktop.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/core"
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
	app.WaitFor("id:mobile-session", 10*time.Second)
	shot(app, "60-mobile-sessions")
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
	var built *app
	root := func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}
	app := nsgotest.Start(t, root, nsgotest.Size(1320, 860))
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-remote", 5*time.Second)
	app.Press("id:settings-tab-remote")
	app.WaitFor("text:连接方式", 5*time.Second)
	app.Advance(500 * time.Millisecond)
	shot(app, "62-remote-settings")

	// The code the phone scans, over the workbench rather than the settings.
	built.settings.Set(false)
	app.Advance(300 * time.Millisecond)
	built.showQR("http://10.0.2.2:8787/?token=demo-token")
	app.WaitFor("id:remote-qr", 5*time.Second)
	app.Advance(400 * time.Millisecond)
	shot(app, "67-remote-qr")
}

// TestRemoteSessionActions drives the phone's write endpoints against a
// real app: create, rename, pin and delete.
func TestRemoteSessionActions(t *testing.T) {
	home := t.TempDir()
	// The app keeps a watcher on the workspace; its folder is removed by
	// hand so the test's own cleanup does not race it.
	workspace, err := os.MkdirTemp("", "pideck-actions")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		time.Sleep(200 * time.Millisecond)
		_ = os.RemoveAll(workspace)
	})
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "ActionsProject"}},
		Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	var built *app
	root := func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}
	screen := nsgotest.Start(t, root, nsgotest.Size(1200, 800))
	if built == nil || built.remote == nil {
		t.Fatal("the app did not build its remote host")
	}
	built.remote.mu.Lock()
	built.remote.token = "phone-token"
	built.remote.mu.Unlock()
	handler := built.remote.handler()

	// The handler waits for the UI thread, so each request runs in its own
	// goroutine while this one pumps the app.
	call := func(method, path, body string) *httptest.ResponseRecorder {
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			req := httptest.NewRequest(method, path, strings.NewReader(body))
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
			default:
				if time.Now().After(deadline) {
					t.Fatal("request timed out")
				}
				screen.Settle()
				time.Sleep(2 * time.Millisecond)
			}
		}
	}
	stateSessions := func() []remoteWireSession {
		rec := call(http.MethodGet, "/api/state", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("state = %d: %s", rec.Code, rec.Body.String())
		}
		var snap remoteWireSnapshot
		if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
			t.Fatal(err)
		}
		var out []remoteWireSession
		for _, p := range snap.Projects {
			out = append(out, p.Sessions...)
		}
		return out
	}

	rec := call(http.MethodPost, "/api/sessions", `{"project":`+strconv.Quote(workspace)+`}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("create body = %s", rec.Body.String())
	}
	if got := stateSessions(); len(got) != 1 || got[0].ID != created.ID {
		t.Fatalf("sessions after create = %+v", got)
	}

	rec = call(http.MethodPost, "/api/sessions/"+created.ID+"/rename", `{"title":"手机起的名字"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("rename = %d: %s", rec.Code, rec.Body.String())
	}
	if got := stateSessions(); len(got) != 1 || got[0].Title != "手机起的名字" {
		t.Fatalf("title after rename = %+v", got)
	}

	rec = call(http.MethodPost, "/api/sessions/"+created.ID+"/pin", `{"pinned":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("pin = %d: %s", rec.Code, rec.Body.String())
	}
	if got := stateSessions(); len(got) != 1 || !got[0].Pinned {
		t.Fatalf("pinned after pin = %+v", got)
	}

	// Model and thinking choices come back for the sheet, and empty
	// values are refused.
	rec = call(http.MethodGet, "/api/session/"+created.ID+"/options", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("options = %d: %s", rec.Code, rec.Body.String())
	}
	var options remoteWireOptions
	if err := json.Unmarshal(rec.Body.Bytes(), &options); err != nil {
		t.Fatalf("options body = %s", rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/sessions/"+created.ID+"/model", `{"provider":"x","id":""}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty model = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/sessions/"+created.ID+"/thinking", `{"level":" "}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty level = %d: %s", rec.Code, rec.Body.String())
	}

	// Images ride along with a prompt; broken ones are refused.
	const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	rec = call(http.MethodPost, "/api/sessions/"+created.ID+"/prompt",
		`{"text":"看图","images":[{"mime":"image/png","data":"`+pixel+`"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("prompt with image = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/sessions/"+created.ID+"/prompt", `{"images":[{"mime":"image/png","data":"!!"}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("broken image = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/sessions/"+created.ID+"/prompt", `{}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty prompt = %d: %s", rec.Code, rec.Body.String())
	}

	// A pending question reaches the phone, and the phone's answer clears
	// it and reaches the waiting side.
	var replied string
	posted := make(chan bool, 1)
	built.cx.Post(func() {
		s := built.byID[created.ID]
		if s == nil {
			posted <- false
			return
		}
		s.ask.Set(&extensionAsk{ID: "q1", Method: "select", Title: "允许运行？", Message: "要跑测试", Options: []string{"允许", "拒绝"}})
		s.acpReply = func(name string) { replied = name }
		posted <- true
	})
	screen.Settle()
	if !<-posted {
		t.Fatal("the session vanished")
	}
	if got := stateSessions(); len(got) != 1 || got[0].Ask == nil || got[0].Ask.Title != "允许运行？" || len(got[0].Ask.Options) != 2 {
		t.Fatalf("state ask = %+v", got)
	}
	rec = call(http.MethodGet, "/api/session/"+created.ID, "")
	var tr remoteWireTranscript
	if err := json.Unmarshal(rec.Body.Bytes(), &tr); err != nil || tr.Ask == nil || tr.Ask.Message != "要跑测试" {
		t.Fatalf("transcript ask = %+v, %v", tr.Ask, err)
	}
	rec = call(http.MethodPost, "/api/sessions/"+created.ID+"/answer", `{"value":"随便"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown option = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/sessions/"+created.ID+"/answer", `{"value":"允许"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("answer = %d: %s", rec.Code, rec.Body.String())
	}
	if replied != "允许" {
		t.Fatalf("the waiting side got %q", replied)
	}
	if got := stateSessions(); len(got) != 1 || got[0].Ask != nil {
		t.Fatalf("ask after answer = %+v", got)
	}

	rec = call(http.MethodPost, "/api/sessions/"+created.ID+"/delete", `{}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete = %d: %s", rec.Code, rec.Body.String())
	}
	if got := stateSessions(); len(got) != 0 {
		t.Fatalf("sessions after delete = %+v", got)
	}

	// A missing session is a 400 with a readable message, not a panic.
	rec = call(http.MethodPost, "/api/sessions/nope/rename", `{"title":"x"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown session = %d: %s", rec.Code, rec.Body.String())
	}
	// The token still guards every write.
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", strings.NewReader("{}"))
	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, req)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("no token = %d", unauthorized.Code)
	}
}

// TestRemoteSearch finds a word in a session's messages.
func TestRemoteSearch(t *testing.T) {
	home := t.TempDir()
	workspace, err := os.MkdirTemp("", "pideck-search")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		time.Sleep(200 * time.Millisecond)
		_ = os.RemoveAll(workspace)
	})
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "SearchProject"}},
		Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	const id = "search-1"
	header, _ := json.Marshal(map[string]any{"type": "session", "version": 3, "id": id,
		"timestamp": "2026-01-02T03:04:05.000Z", "cwd": filepath.ToSlash(workspace)})
	message, _ := json.Marshal(map[string]any{"type": "message", "id": "m1", "timestamp": "2026-01-02T03:04:06.000Z",
		"message": map[string]any{"role": "user", "content": "帮我找一下蓝色按钮的样式", "timestamp": 1767323046000}})
	name := filepath.Join(dir, "2026-01-02T03-04-05-000Z_"+id+".jsonl")
	if err := os.WriteFile(name, append(append(header, '\n'), message...), 0o644); err != nil {
		t.Fatal(err)
	}

	var built *app
	root := func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}
	screen := nsgotest.Start(t, root, nsgotest.Size(1200, 800))
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
					t.Fatal("search timed out")
				}
				screen.Settle()
			}
		}
	}

	rec := call("/api/search?q=" + url.QueryEscape("蓝色按钮"))
	if rec.Code != http.StatusOK {
		t.Fatalf("search = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Hits []remoteWireHit `json:"hits"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Hits) != 1 || out.Hits[0].Session != id {
		t.Fatalf("hits = %+v", out.Hits)
	}
	if !strings.Contains(out.Hits[0].Snippet, "蓝色按钮") {
		t.Fatalf("snippet = %q", out.Hits[0].Snippet)
	}
	// One character is not a search.
	if rec := call("/api/search?q=" + url.QueryEscape("蓝")); rec.Code != http.StatusBadRequest {
		t.Fatalf("short query = %d", rec.Code)
	}
}

// TestQRRoundTrip encodes a connection link and reads it back, the way the
// desktop shows a code and the phone scans it.
func TestQRRoundTrip(t *testing.T) {
	link := "http://10.0.2.2:8787/?token=abc123"
	if given := os.Getenv("PIDECK_QR_LINK"); given != "" {
		link = given
	}
	png := qrPNGFor(link)
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

// TestMobileAsk answers the desktop's pending question from the phone.
func TestMobileAsk(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	const token = "phone-token"
	var mu sync.Mutex
	ask := &remoteWireAsk{Method: "confirm", Title: "允许运行 go test？", Message: "桌面在等你"}
	var answered map[string]any
	state := remoteWireSnapshot{Name: "PiDeck Lite", Host: "desk", Projects: []remoteWireProject{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remoteWireSession{{ID: "s1", Title: "电脑上的会话"}},
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
		tr := remoteWireTranscript{ID: "s1", Title: "电脑上的会话", Ask: ask}
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
	app.WaitFor("id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
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
