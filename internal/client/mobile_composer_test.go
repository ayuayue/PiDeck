package client

// Drives the phone's composer against a fake desktop: the model, the
// thinking level and the picture button sit in the card's own row on both
// the new-session page and an open session, a press on send reaches the
// desktop, and a failed send says so instead of doing nothing.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// testPixel is a one-pixel PNG, the picture the fake desktop "draws".
const testPixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

// fakeComposerDesktop is the desktop the composer tests talk to. It records
// what it was asked and can refuse the next prompt.
type fakeComposerDesktop struct {
	mu       sync.Mutex
	prompts  []string
	thinking string
	models   []string
	mode     string
	backend  string
	image    string
	tool     string
	failNext bool
	sessions int
	server   *httptest.Server
	token    string
}

func newComposerDesktop(t *testing.T, sessions ...remotewire.Session) *fakeComposerDesktop {
	t.Helper()
	d := &fakeComposerDesktop{token: "phone-token", sessions: len(sessions)}
	state := remotewire.Snapshot{Name: "PiDeck Lite", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: sessions,
	}}}
	mux := http.NewServeMux()
	check := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+d.token {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	reply := func(w http.ResponseWriter, v any) { _ = json.NewEncoder(w).Encode(v) }
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			reply(w, map[string]any{"name": "PiDeck Lite", "host": "desk"})
		}
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		d.mu.Lock()
		mode := d.mode
		d.mu.Unlock()
		snap := state
		for i := range snap.Projects {
			for j := range snap.Projects[i].Sessions {
				snap.Projects[i].Sessions[j].Mode = mode
			}
		}
		reply(w, snap)
	})
	mux.HandleFunc("/api/files", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		reply(w, map[string]any{"files": []remotewire.File{{Path: "src/main.go", Size: 128}, {Path: "README.md", Size: 64}}})
	})
	mux.HandleFunc("/api/sessions", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		reply(w, map[string]string{"id": "s2", "title": "新会话"})
	})
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/options"):
			d.mu.Lock()
			mode, backend := d.mode, d.backend
			d.mu.Unlock()
			reply(w, remotewire.Options{Model: "m1", Thinking: "low", Levels: []string{"low", "high"},
				Models:  []remotewire.Model{{ID: "m1", Name: "模型一", Provider: "pi"}},
				Mode:    mode,
				Backend: backend, BackendName: "pi",
				Backends: []remotewire.Backend{{ID: "pi", Name: "pi"}, {ID: "acp:claude", Name: "ACP Claude"}},
				Tools:    []string{"prompt", "predict"}})
		default:
			reply(w, remotewire.Transcript{ID: "s1", Title: "电脑上的会话",
				Messages: []remotewire.Message{{Role: "assistant", Text: "先前的回复"}}})
		}
	})
	mux.HandleFunc("/api/sessions/", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/prompt"):
			var body struct {
				Text string `json:"text"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			d.mu.Lock()
			fail := d.failNext
			d.failNext = false
			if !fail {
				d.prompts = append(d.prompts, body.Text)
			}
			d.mu.Unlock()
			if fail {
				w.WriteHeader(http.StatusBadRequest)
				reply(w, map[string]string{"error": "这个项目还没有在电脑上被信任"})
				return
			}
			reply(w, map[string]any{"ok": true})
		case strings.HasSuffix(r.URL.Path, "/thinking"):
			var body struct {
				Level string `json:"level"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			d.mu.Lock()
			d.thinking = body.Level
			d.mu.Unlock()
			reply(w, map[string]any{"ok": true})
		case strings.HasSuffix(r.URL.Path, "/mode"):
			var body struct {
				Mode string `json:"mode"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			echo := body.Mode
			if echo == "normal" {
				echo = ""
			}
			d.mu.Lock()
			d.mode = echo
			d.mu.Unlock()
			reply(w, map[string]string{"ok": "1", "mode": echo})
		case strings.HasSuffix(r.URL.Path, "/backend"):
			var body struct {
				Backend string `json:"backend"`
				Preset  string `json:"preset"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			chosen := body.Backend
			if body.Preset != "" {
				chosen += ":" + body.Preset
			}
			d.mu.Lock()
			d.backend = chosen
			d.mu.Unlock()
			reply(w, map[string]any{"ok": true, "backend": body.Backend, "name": body.Backend})
		case strings.HasSuffix(r.URL.Path, "/tools"):
			var body struct {
				Tool string `json:"tool"`
				Text string `json:"text"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			d.mu.Lock()
			d.tool = body.Tool
			d.mu.Unlock()
			text := "改写后的：" + body.Text
			if body.Tool == "predict" {
				text = "接着写"
			}
			reply(w, map[string]string{"text": text})
		case strings.HasSuffix(r.URL.Path, "/image"):
			var body struct {
				Prompt string `json:"prompt"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			d.mu.Lock()
			d.image = body.Prompt
			d.mu.Unlock()
			reply(w, remotewire.Pictures{Images: []remotewire.Picture{{Mime: "image/png", Data: testPixel}}})
		case strings.HasSuffix(r.URL.Path, "/model"):
			var body struct {
				ID string `json:"id"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			d.mu.Lock()
			d.models = append(d.models, body.ID)
			d.mu.Unlock()
			reply(w, map[string]any{"ok": true})
		default:
			http.NotFound(w, r)
		}
	})
	d.server = httptest.NewServer(mux)
	t.Cleanup(d.server.Close)
	return d
}

// open connects the app to this desktop and waits for the project list.
func (d *fakeComposerDesktop) open(t *testing.T, app **nsgotest.App) {
	t.Helper()
	t.Setenv("PIDECK_LITE_MOBILE", "1")
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	t.Setenv("PIDECK_LITE_LANG", "zh-CN")
	*app = nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	(*app).WaitFor("id:mobile-server", 10*time.Second)
	(*app).Type("id:mobile-server", d.server.URL)
	(*app).Type("id:mobile-token", d.token)
	(*app).Press("id:mobile-connect")
	// The phone opens on the new-session page: the composer is there.
	waitApp(*app, "id:mobile-draft", 15*time.Second)
}

func (d *fakeComposerDesktop) sentPrompts() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.prompts...)
}

func (d *fakeComposerDesktop) chosenLevel() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.thinking
}

// TestMobileComposerControls keeps the model, the thinking level and the
// picture button in the composer's row of an open session.
func TestMobileComposerControls(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "text:先前的回复", 15*time.Second)

	// The row holds the three controls the desktop's composer has.
	for _, id := range []string{"mobile-model", "mobile-thinking", "mobile-image", "mobile-send"} {
		app.WaitFor("id:"+id, 10*time.Second)
	}
	// The model line fills in from the session's options.
	waitApp(app, "text:模型一", 10*time.Second)

	// The thinking chip opens the sheet, and a level goes to the desktop.
	app.Press("id:mobile-thinking")
	waitApp(app, "id:mobile-level", 10*time.Second)
	app.Press("id:mobile-level >> nth=1")
	waitFor(t, app, 10*time.Second, func() bool { return desk.chosenLevel() == "high" })
	app.Advance(300 * time.Millisecond)
	app.WaitForGone("id:mobile-options-sheet", 5*time.Second)
}

// TestMobileComposerSends is the regression for "typing then pressing send
// does nothing": the text leaves the field and reaches the desktop.
func TestMobileComposerSends(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "text:先前的回复", 15*time.Second)

	app.Type("id:mobile-draft", "第二条消息")
	app.Advance(200 * time.Millisecond)
	app.Press("id:mobile-send")
	waitFor(t, app, 10*time.Second, func() bool {
		sent := desk.sentPrompts()
		return len(sent) == 1 && sent[0] == "第二条消息"
	})
	// The field is emptied and the send says it went out, so a press is
	// never silent.
	waitFor(t, app, 5*time.Second, func() bool { return draftValue(app) == "" })
	app.Settle()
	if len(app.Query("text:已发送")) == 0 {
		t.Fatal("no 已发送 confirmation after send")
	}
}

// TestMobileComposerSendFailure is the other half: a refused send returns
// the text to the field and shows why.
func TestMobileComposerSendFailure(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "text:先前的回复", 15*time.Second)

	desk.mu.Lock()
	desk.failNext = true
	desk.mu.Unlock()
	app.Type("id:mobile-draft", "会被拒绝的消息")
	app.Advance(200 * time.Millisecond)
	app.Press("id:mobile-send")
	waitApp(app, "text:这个项目还没有在电脑上被信任", 10*time.Second)
	waitFor(t, app, 5*time.Second, func() bool { return draftValue(app) == "会被拒绝的消息" })
	// The next poll must not wipe the reason: it is the send's own error,
	// not the turn's.
	app.Advance(4 * time.Second)
	waitApp(app, "id:mobile-error", 5*time.Second)
	if got := len(app.Query("text:这个项目还没有在电脑上被信任")); got != 1 {
		t.Fatalf("error lines = %d after a poll, want 1", got)
	}
}

// TestMobileInitComposerPicksModel covers the new-session page: its model
// chip starts the session the first message would have started, keeps the
// draft, and then offers the models.
func TestMobileInitComposerPicksModel(t *testing.T) {
	desk := newComposerDesktop(t)
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-draft", 10*time.Second)
	for _, id := range []string{"mobile-model", "mobile-thinking", "mobile-image"} {
		app.WaitFor("id:"+id, 10*time.Second)
	}
	app.Type("id:mobile-draft", "选模型时写的话")
	app.Advance(200 * time.Millisecond)
	app.Press("id:mobile-model")
	waitApp(app, "id:mobile-options-sheet", 10*time.Second)
	waitApp(app, "text:模型一", 10*time.Second)
	// The text the page held moves into the session it started.
	app.Advance(300 * time.Millisecond)
	app.Press("id:mobile-model-row >> nth=0")
	app.Advance(300 * time.Millisecond)
	waitFor(t, app, 5*time.Second, func() bool { return draftValue(app) == "选模型时写的话" })
}

// TestMobileInitSendKeepsDraft covers a new session whose first message is
// refused: the session starts, and the text the page held comes back in the
// session's composer instead of vanishing.
func TestMobileInitSendKeepsDraft(t *testing.T) {
	desk := newComposerDesktop(t)
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-draft", 10*time.Second)

	desk.mu.Lock()
	desk.failNext = true
	desk.mu.Unlock()
	app.Type("id:mobile-draft", "第一条就被拒了")
	app.Advance(200 * time.Millisecond)
	app.Press("id:mobile-send")
	waitApp(app, "text:这个项目还没有在电脑上被信任", 15*time.Second)
	waitFor(t, app, 5*time.Second, func() bool { return draftValue(app) == "第一条就被拒了" })
}

// draftValue is what the composer's field holds.
func draftValue(app *nsgotest.App) string {
	return app.Find("id:mobile-draft").Text
}

// TestMobileComposerMode drives the add menu's modes: the phone asks the
// desktop, and the chip follows what the desktop holds.
func TestMobileComposerMode(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "text:先前的回复", 15*time.Second)

	app.Press("id:mobile-plus")
	waitApp(app, "id:mobile-mode-plan", 10*time.Second)
	app.Press("id:mobile-mode-plan")
	waitFor(t, app, 10*time.Second, func() bool {
		desk.mu.Lock()
		defer desk.mu.Unlock()
		return desk.mode == "plan"
	})
	waitApp(app, "id:mobile-mode", 10*time.Second)
	waitApp(app, "text:计划", 5*time.Second)

	// The same chip drops it again.
	app.Press("id:mobile-mode")
	waitFor(t, app, 10*time.Second, func() bool {
		desk.mu.Lock()
		defer desk.mu.Unlock()
		return desk.mode == ""
	})
	app.WaitForGone("id:mobile-mode", 5*time.Second)
}

// TestMobileComposerDraftTool rewrites the draft with the desktop's model.
func TestMobileComposerDraftTool(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "text:先前的回复", 15*time.Second)

	app.Type("id:mobile-draft", "把测试跑一遍")
	app.Advance(200 * time.Millisecond)
	app.Press("id:mobile-plus")
	waitApp(app, "id:mobile-enhance", 10*time.Second)
	waitApp(app, "id:mobile-predict", 5*time.Second)
	app.Press("id:mobile-enhance")
	waitApp(app, "text:改写后的：把测试跑一遍", 10*time.Second)
	waitFor(t, app, 5*time.Second, func() bool { return draftValue(app) == "改写后的：把测试跑一遍" })
	desk.mu.Lock()
	tool := desk.tool
	desk.mu.Unlock()
	if tool != "prompt" {
		t.Fatalf("tool = %q, want prompt", tool)
	}
}

// TestMobileComposerMention inserts an @path from the project's files.
func TestMobileComposerMention(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "text:先前的回复", 15*time.Second)

	app.Press("id:mobile-plus")
	waitApp(app, "id:mobile-mention", 10*time.Second)
	app.Press("id:mobile-mention")
	waitApp(app, "id:mobile-file", 10*time.Second)
	app.Press("id:mobile-file >> nth=0")
	waitFor(t, app, 5*time.Second, func() bool { return draftValue(app) == "@src/main.go " })
	// The list closes: its rows leave the screen.
	app.Advance(500 * time.Millisecond)
	app.WaitForGone("id:mobile-file", 5*time.Second)
}

// TestMobileInitComposerMention is the same on the new-session page: the
// mention goes into the page's own draft, which the session inherits.
func TestMobileInitComposerMention(t *testing.T) {
	desk := newComposerDesktop(t)
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-draft", 10*time.Second)

	app.Press("id:mobile-plus")
	waitApp(app, "id:mobile-mention", 10*time.Second)
	app.Press("id:mobile-mention")
	waitApp(app, "id:mobile-file", 10*time.Second)
	app.Press("id:mobile-file >> nth=0")
	waitFor(t, app, 5*time.Second, func() bool { return draftValue(app) == "@src/main.go " })
}

// TestMobileComposerBackend switches where a blank session runs from the
// options sheet.
func TestMobileComposerBackend(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "text:先前的回复", 15*time.Second)

	app.Press("id:mobile-model")
	waitApp(app, "id:mobile-options-sheet", 10*time.Second)
	app.WaitFor("text:ACP Claude", 10*time.Second)
	app.Press("text:ACP Claude")
	waitFor(t, app, 10*time.Second, func() bool {
		desk.mu.Lock()
		defer desk.mu.Unlock()
		return desk.backend == "acp:claude"
	})
}
