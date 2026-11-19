//go:build !js && !android && !ios

package workbench

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
	"testing"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
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
	app.WaitFor("text:外网访问", 5*time.Second)
	app.WaitFor("id:remote-relay-url", 5*time.Second)
	app.WaitFor("id:remote-public-url", 5*time.Second)
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
	// The app runs git itself, so the identity has to be in the environment
	// rather than on a command line: a runner has none configured.
	for _, env := range []string{"GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"} {
		t.Setenv(env, "PiDeck Test")
	}
	for _, env := range []string{"GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"} {
		t.Setenv(env, "pideck@example.com")
	}
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
	stateSessions := func() []remotewire.Session {
		rec := call(http.MethodGet, "/api/state", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("state = %d: %s", rec.Code, rec.Body.String())
		}
		var snap remotewire.Snapshot
		if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
			t.Fatal(err)
		}
		var out []remotewire.Session
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
	var options remotewire.Options
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
	var tr remotewire.Transcript
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

	// Git endpoints read the workspace's repository.
	if _, _, _, err := gitRun(localTarget, workspace, 30*time.Second, "init"); err != nil {
		t.Fatalf("git init: %v", err)
	}
	tracked := filepath.Join(workspace, "tracked.txt")
	if err := os.WriteFile(tracked, []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"add", "-A"},
		{"-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-m", "init"},
	} {
		if _, stderr, _, err := gitRun(localTarget, workspace, 30*time.Second, args...); err != nil {
			t.Fatalf("git %v: %v %s", args, err, stderr)
		}
	}
	if err := os.WriteFile(tracked, []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec = call(http.MethodGet, "/api/git?project="+url.QueryEscape(workspace), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("git = %d: %s", rec.Code, rec.Body.String())
	}
	var g remotewire.Git
	if err := json.Unmarshal(rec.Body.Bytes(), &g); err != nil || !g.IsRepo || len(g.Files) == 0 {
		t.Fatalf("git state = %+v, %v", g, err)
	}
	if g.Files[0].Path != "tracked.txt" || g.Files[0].Mark != "M" {
		t.Fatalf("git files = %+v", g.Files)
	}
	rec = call(http.MethodGet, "/api/git/diff?project="+url.QueryEscape(workspace)+"&path=tracked.txt", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "+changed") {
		t.Fatalf("diff = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodGet, "/api/git/diff?project="+url.QueryEscape(workspace)+"&path=../secret", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("outside path = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/git/stage",
		`{"project":`+strconv.Quote(workspace)+`,"path":"tracked.txt","stage":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("stage = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodGet, "/api/git?project="+url.QueryEscape(workspace), "")
	if err := json.Unmarshal(rec.Body.Bytes(), &g); err != nil || len(g.Files) != 1 || !g.Files[0].Staged {
		t.Fatalf("git after stage = %+v, %v", g, err)
	}
	rec = call(http.MethodPost, "/api/git/commit",
		`{"project":`+strconv.Quote(workspace)+`,"message":"phone commit"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("commit = %d: %s", rec.Code, rec.Body.String())
	}
	if out, _, _, err := gitRun(localTarget, workspace, 30*time.Second, "log", "-1", "--pretty=%s"); err != nil || !strings.Contains(out, "phone commit") {
		t.Fatalf("log = %q, %v", out, err)
	}
	rec = call(http.MethodPost, "/api/git/commit",
		`{"project":`+strconv.Quote(workspace)+`,"message":" "}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty message = %d: %s", rec.Code, rec.Body.String())
	}
	if _, stderr, _, err := gitRun(localTarget, workspace, 30*time.Second, "branch", "feature"); err != nil {
		t.Fatalf("git branch: %v %s", err, stderr)
	}
	rec = call(http.MethodGet, "/api/git?project="+url.QueryEscape(workspace), "")
	if err := json.Unmarshal(rec.Body.Bytes(), &g); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, b := range g.Branches {
		if b == "feature" {
			found = true
		}
	}
	if !found {
		t.Fatalf("branches = %v", g.Branches)
	}
	rec = call(http.MethodPost, "/api/git/checkout",
		`{"project":`+strconv.Quote(workspace)+`,"branch":"feature"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("checkout = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodGet, "/api/git?project="+url.QueryEscape(workspace), "")
	if err := json.Unmarshal(rec.Body.Bytes(), &g); err != nil || g.Branch != "feature" {
		t.Fatalf("branch after checkout = %q, %v", g.Branch, err)
	}
	rec = call(http.MethodPost, "/api/git/checkout",
		`{"project":`+strconv.Quote(workspace)+`,"branch":"nope"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown branch = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/git/sync",
		`{"project":`+strconv.Quote(workspace)+`,"action":"fetch"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("fetch = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/git/sync",
		`{"project":`+strconv.Quote(workspace)+`,"action":"bogus"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad sync = %d: %s", rec.Code, rec.Body.String())
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

// TestRemoteRailLists serves the three lists the rail opens: the agents a
// new session can start with, the cron tasks, and the favorites.
func TestRemoteRailLists(t *testing.T) {
	home := t.TempDir()
	// The app keeps a watcher on the workspace; its folder is removed by
	// hand so the test's own cleanup does not race it.
	workspace, err := os.MkdirTemp("", "pideck-rail")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		time.Sleep(200 * time.Millisecond)
		_ = os.RemoveAll(workspace)
	})
	t.Setenv("PIDECK_LITE_HOME", home)
	apptext.SetLanguage(apptext.LangZhCN)
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	write := func(name string, value any) {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, name), raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("config.json", config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "RailProject"}},
		Theme: "system", SidebarOpen: true, ScanPi: false})
	write("tasks.json", map[string]any{"version": 1, "tasks": []map[string]any{{
		"id": "t1", "name": "晨报", "prompt": "写今天的晨报", "project": workspace,
		"cron": "0 9 * * *", "enabled": true,
	}}})
	write("favorites.json", map[string]any{"version": 1, "entries": []map[string]any{
		{"id": "f1", "kind": "reply", "sessionId": "s1", "sessionTitle": "电脑上的会话",
			"project": workspace, "prompt": "怎么跑测试", "text": "go test ./..."},
		{"id": "f2", "kind": "session", "sessionId": "s1", "sessionTitle": "电脑上的会话"},
	}})

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

	rec := call(http.MethodGet, "/api/agents", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("agents = %d: %s", rec.Code, rec.Body.String())
	}
	var agents remotewire.Agents
	if err := json.Unmarshal(rec.Body.Bytes(), &agents); err != nil {
		t.Fatalf("agents body = %s", rec.Body.String())
	}
	found := false
	for _, a := range agents.Agents {
		if a.ID == "review" && a.Name != "" && a.Description != "" {
			found = true
		}
	}
	if !found {
		t.Fatalf("agents = %+v", agents.Agents)
	}

	// A session started with an agent keeps it, and is named after it.
	rec = call(http.MethodPost, "/api/sessions", `{"project":`+strconv.Quote(workspace)+`,"agent":"review"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("create with agent = %d: %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("created = %s", rec.Body.String())
	}
	if got := built.agentByID("review"); got == nil || created.Title != got.Name {
		t.Fatalf("session title = %q, want the agent's name", created.Title)
	}
	// The UI thread is the test's own: ask it what the session kept.
	persona := make(chan string, 1)
	built.cx.Post(func() {
		got := ""
		if s := built.byID[created.ID]; s != nil {
			got = s.personaID
		}
		persona <- got
	})
	screen.Settle()
	if got := <-persona; got != "review" {
		t.Fatalf("session persona = %q, want review", got)
	}
	rec = call(http.MethodGet, "/api/tasks", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("tasks = %d: %s", rec.Code, rec.Body.String())
	}
	var tasks remotewire.Tasks
	if err := json.Unmarshal(rec.Body.Bytes(), &tasks); err != nil {
		t.Fatalf("tasks body = %s", rec.Body.String())
	}
	if len(tasks.Tasks) != 1 || tasks.Tasks[0].Name != "晨报" || !tasks.Tasks[0].Enabled {
		t.Fatalf("tasks = %+v", tasks.Tasks)
	}
	if tasks.Tasks[0].NextRunAt == 0 {
		t.Fatalf("no next run: %+v", tasks.Tasks[0])
	}

	rec = call(http.MethodPost, "/api/tasks/t1/toggle", `{"enabled":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("toggle = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodGet, "/api/tasks", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &tasks); err != nil || len(tasks.Tasks) != 1 || tasks.Tasks[0].Enabled {
		t.Fatalf("tasks after toggle = %+v, %v", tasks.Tasks, err)
	}
	rec = call(http.MethodPost, "/api/tasks/t1/jump", `{}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown task action = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/tasks/t1/toggle", `{}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("toggle without a value = %d: %s", rec.Code, rec.Body.String())
	}

	rec = call(http.MethodGet, "/api/favorites", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("favorites = %d: %s", rec.Code, rec.Body.String())
	}
	var favorites remotewire.Favorites
	if err := json.Unmarshal(rec.Body.Bytes(), &favorites); err != nil {
		t.Fatalf("favorites body = %s", rec.Body.String())
	}
	if len(favorites.Favorites) != 2 {
		t.Fatalf("favorites = %+v", favorites.Favorites)
	}
	kinds := map[string]bool{}
	for _, f := range favorites.Favorites {
		kinds[f.Kind] = true
		if f.Kind == favoriteReply && f.Text == "" {
			t.Fatalf("reply without text: %+v", f)
		}
	}
	if !kinds["reply"] || !kinds["session"] {
		t.Fatalf("favorite kinds = %+v", kinds)
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
	// Session readers and child processes can keep a Windows handle briefly
	// after the test. editorWorkspace retries its removal; t.TempDir does not.
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", editorWorkspace(t))
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
		Hits []remotewire.Hit `json:"hits"`
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

// TestRemoteGitCommits carries at most twenty commits to the phone.
func TestRemoteGitCommits(t *testing.T) {
	var st gitState
	for i := 0; i < 30; i++ {
		st.Commits = append(st.Commits, gitCommit{Hash: "h", Short: "s", Subject: "提交", Author: "Dev",
			Date: time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)})
	}
	out := remoteGitOf(st)
	if len(out.Commits) != 20 {
		t.Fatalf("commits = %d, want 20", len(out.Commits))
	}
	if out.Commits[0].Subject != "提交" || out.Commits[0].When != "2026-06-01" {
		t.Fatalf("commit = %+v", out.Commits[0])
	}
}
