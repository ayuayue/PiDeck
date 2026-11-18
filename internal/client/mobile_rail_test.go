package client

// Drives the phone's rail — the drawer with the brand, the ways in and the
// projects — against a fake desktop: an agent starts a session, a task is
// switched off, a favorite opens, and the look is kept.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileRail(t *testing.T) {
	const token = "phone-token"
	var mu sync.Mutex
	state := remotewire.Snapshot{Name: "PiDeck Lite", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{
			{ID: "s1", Title: "电脑上的会话", Status: "idle", Updated: time.Now().UnixMilli()},
		},
	}}}
	tasked := false
	agentAsked := ""
	taskSwitched := map[string]bool{}
	check := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	reply := func(w http.ResponseWriter, v any) { _ = json.NewEncoder(w).Encode(v) }
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			reply(w, map[string]any{"name": "PiDeck Lite", "host": "desk"})
		}
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			reply(w, state)
		}
	})
	mux.HandleFunc("/api/agents", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			reply(w, remotewire.Agents{Agents: []remotewire.Agent{
				{ID: "review", Name: "代码审查", Description: "先列问题与风险。"},
			}})
		}
	})
	mux.HandleFunc("/api/tasks", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			mu.Lock()
			defer mu.Unlock()
			reply(w, remotewire.Tasks{Tasks: []remotewire.Task{{
				ID: "t1", Name: "晨报", Prompt: "写今天的晨报", Project: "/tmp/project",
				Cron: "0 9 * * *", Enabled: !tasked, NextRunAt: time.Now().Add(time.Hour).UnixMilli(),
			}}})
		}
	})
	mux.HandleFunc("/api/tasks/", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		var body struct {
			Enabled bool `json:"enabled"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		taskSwitched[strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/tasks/t1/"), "/")] = body.Enabled
		tasked = !body.Enabled
		mu.Unlock()
		reply(w, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/favorites", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			reply(w, remotewire.Favorites{Favorites: []remotewire.Favorite{
				{ID: "f1", Kind: "reply", SessionID: "s1", SessionTitle: "电脑上的会话",
					Prompt: "怎么跑测试", Text: "go test ./...", CreatedAt: time.Now().UnixMilli()},
				{ID: "f2", Kind: "session", SessionID: "s1", SessionTitle: "电脑上的会话"},
			}})
		}
	})
	mux.HandleFunc("/api/sessions", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		var body struct {
			Project string `json:"project"`
			Agent   string `json:"agent"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		agentAsked = body.Agent
		mu.Unlock()
		title := "新会话"
		if body.Agent == "review" {
			title = "代码审查"
		}
		reply(w, map[string]string{"id": "s9", "title": title})
	})
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		if strings.HasSuffix(r.URL.Path, "/s1") {
			reply(w, remotewire.Transcript{ID: "s1", Title: "电脑上的会话",
				Messages: []remotewire.Message{{Role: "assistant", Text: "这是电脑上的会话。"}}})
			return
		}
		reply(w, remotewire.Transcript{ID: "s9", Title: "代码审查",
			Messages: []remotewire.Message{{Role: "assistant", Text: "智能体会话已经开始了。"}}})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	home := t.TempDir()
	t.Setenv("PIDECK_LITE_MOBILE", "1")
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_LANG", "zh-CN")
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-server", 10*time.Second)
	app.Type("id:mobile-server", server.URL)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")

	// The phone opens on the new-session page: a project and a composer.
	waitApp(app, "id:mobile-init-project", 15*time.Second)
	app.WaitFor("id:mobile-draft", 10*time.Second)
	waitApp(app, "text:电脑项目", 10*time.Second)
	shot(app, "67-mobile-home")

	// The drawer holds the brand, the ways in and the projects.
	openPhoneRail(app)
	for _, id := range []string{"mobile-search", "mobile-agents", "mobile-tasks", "mobile-favorites",
		"mobile-new", "mobile-settings", "mobile-theme"} {
		app.WaitFor("id:"+id, 5*time.Second)
	}
	app.WaitFor("id:mobile-session", 5*time.Second)
	shot(app, "68-mobile-drawer")

	// An agent starts a session that keeps the way of working.
	app.Press("id:mobile-agents")
	waitApp(app, "id:mobile-agent", 10*time.Second)
	shot(app, "69-mobile-agents")
	app.Press("id:mobile-agent >> nth=0")
	waitApp(app, "text:智能体会话已经开始了。", 15*time.Second)
	mu.Lock()
	asked := agentAsked
	mu.Unlock()
	if asked != "review" {
		t.Fatalf("agent asked = %q, want review", asked)
	}
	app.Advance(600 * time.Millisecond)

	// A cron task switches off from the phone.
	app.WaitForGone("id:mobile-agents-sheet", 5*time.Second)
	app.Advance(400 * time.Millisecond)
	openPhoneRail(app)
	app.Advance(400 * time.Millisecond)
	app.WaitFor("id:mobile-tasks", 5*time.Second)
	app.Press("id:mobile-tasks")
	waitApp(app, "id:mobile-task-switch", 10*time.Second)
	app.Press("id:mobile-task")
	app.WaitFor("text:写今天的晨报", 5*time.Second)
	shot(app, "70-mobile-tasks")
	app.Press("id:mobile-task-switch")
	waitFor(t, app, 10*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		enabled, seen := taskSwitched["toggle"]
		return seen && !enabled
	})
	app.WaitFor("text:0 9 * * * · 已暂停", 10*time.Second)
	app.Key("escape")
	app.Advance(400 * time.Millisecond)

	// A saved answer reads in full; a saved session opens.
	app.WaitForGone("id:mobile-tasks-sheet", 5*time.Second)
	openPhoneRail(app)
	app.WaitFor("id:mobile-favorites", 5*time.Second)
	app.Press("id:mobile-favorites")
	waitApp(app, "id:mobile-favorite", 10*time.Second)
	shot(app, "71-mobile-favorites")
	app.Press("id:mobile-favorite >> nth=0")
	waitApp(app, "text:go test ./...", 10*time.Second)
	app.WaitFor("id:mobile-favorite-copy", 5*time.Second)
	app.Key("escape")
	app.Advance(400 * time.Millisecond)
	app.WaitForGone("id:mobile-favorite-sheet", 5*time.Second)
	app.Press("id:mobile-favorite >> nth=1")
	waitApp(app, "text:这是电脑上的会话。", 15*time.Second)
	app.Advance(400 * time.Millisecond)
	app.WaitForGone("id:mobile-favorites-sheet", 5*time.Second)

	// The look steps through system, light and dark, and is kept.
	app.Advance(400 * time.Millisecond)
	openPhoneRail(app)
	app.WaitFor("id:mobile-theme", 5*time.Second)
	app.WaitFor("text:跟随系统", 5*time.Second)
	app.Press("id:mobile-theme")
	app.WaitFor("text:浅色", 5*time.Second)
	app.Press("id:mobile-theme")
	app.WaitFor("text:深色", 5*time.Second)
	app.Advance(300 * time.Millisecond)
	shot(app, "72-mobile-dark")
	raw, err := os.ReadFile(filepath.Join(home, "remote.json"))
	if err != nil {
		t.Fatalf("remote.json: %v", err)
	}
	var saved mobileSaved
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatalf("remote.json = %s", raw)
	}
	if saved.Appearance != appearanceDark {
		t.Fatalf("saved appearance = %q, want %q", saved.Appearance, appearanceDark)
	}

	// The settings sheet names the desktop and offers the way out.
	app.Press("id:mobile-settings")
	app.WaitFor("id:mobile-settings-sheet", 5*time.Second)
	app.WaitFor("text:"+shortHostForTest(server.URL), 5*time.Second)
	app.WaitFor("id:mobile-disconnect", 5*time.Second)
	app.Key("escape")
	app.Advance(400 * time.Millisecond)
	app.WaitForGone("id:mobile-settings-sheet", 5*time.Second)
	openPhoneRail(app)
	app.WaitFor("id:mobile-theme", 5*time.Second)
	app.Press("id:mobile-theme")
	app.WaitFor("text:跟随系统", 5*time.Second)
}

// shortHostForTest is what the settings sheet shows of a server: the base
// the client kept, without a trailing slash.
func shortHostForTest(server string) string {
	return strings.TrimSuffix(server, "/")
}

// TestMobileWideRail keeps the rail beside the page in a window wide enough
// for both columns, as the desktop does.
func TestMobileWideRail(t *testing.T) {
	const token = "phone-token"
	state := remotewire.Snapshot{Name: "PiDeck Lite", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{
			{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()},
		},
	}}}
	server := newTestHTTPServer(t, token, state, remotewire.Transcript{ID: "s1", Title: "电脑上的会话"})
	defer server.Close()

	t.Setenv("PIDECK_LITE_MOBILE", "1")
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	t.Setenv("PIDECK_LITE_LANG", "zh-CN")
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.WaitFor("id:mobile-server", 10*time.Second)
	app.Type("id:mobile-server", server.URL)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")

	// Both columns show at once: the rail with its sessions, the page
	// beside it, and no drawer toggle to open either.
	waitApp(app, "id:mobile-session", 15*time.Second)
	app.WaitFor("id:mobile-new", 5*time.Second)
	app.WaitFor("id:mobile-draft", 5*time.Second)
	if got := len(app.Query("id:mobile-drawer")); got != 0 {
		t.Fatalf("drawer toggles = %d, want none in a wide window", got)
	}
	shot(app, "73-mobile-wide")

	// The rail folds away and comes back, as the desktop's does.
	app.Press("id:mobile-rail-toggle")
	app.WaitForGone("id:mobile-session", 5*time.Second)
	app.Press("id:mobile-rail-toggle")
	waitApp(app, "id:mobile-session", 10*time.Second)

	// A session opens in the page while the rail stays where it is.
	app.Press("id:mobile-session")
	app.WaitFor("id:mobile-draft", 10*time.Second)
	app.WaitFor("id:mobile-new", 5*time.Second)
}
