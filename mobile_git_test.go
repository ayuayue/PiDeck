package main

// Checks the phone's read-only Git sheet against a fake desktop.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestMobileGit(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	const token = "phone-token"
	state := remoteWireSnapshot{Name: "PiDeck Lite", Host: "desk", Projects: []remoteWireProject{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remoteWireSession{{ID: "s1", Title: "电脑上的会话"}},
	}}}
	var mu sync.Mutex
	staged := false
	committed := ""
	repo := remoteWireGit{IsRepo: true, Branch: "main", Upstream: "origin/main", Ahead: 1,
		Files: []remoteWireGitFile{{Path: "src/app.ts", Mark: "M"}}}
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
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(remoteWireTranscript{ID: "s1", Title: "电脑上的会话"})
		}
	})
	mux.HandleFunc("/api/git", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			mu.Lock()
			out := repo
			out.Files = append([]remoteWireGitFile(nil), repo.Files...)
			out.Files[0].Staged = staged
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(out)
		}
	})
	mux.HandleFunc("/api/git/stage", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		var body struct {
			Stage bool `json:"stage"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		staged = body.Stage
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/git/commit", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		var body struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		committed = body.Message
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/git/diff", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(map[string]string{"patch": "@@ -1 +1 @@\n-old\n+new\n"})
		}
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
	app.WaitFor("id:mobile-git-0", 10*time.Second)
	app.Press("id:mobile-git-0")
	waitApp(app, "id:mobile-git", 10*time.Second)
	waitApp(app, "text:main", 5*time.Second)
	app.WaitFor("id:mobile-git-file-0", 5*time.Second)
	app.Press("id:mobile-git-file-0")
	waitApp(app, "id:mobile-git-diff", 10*time.Second)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:+new")) > 0 })
	app.Press("id:mobile-git-diff-close")
	app.WaitForGone("id:mobile-git-diff", 5*time.Second)

	// Stage the file, then commit it with a message.
	app.Press("id:mobile-git-stage-0")
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		got := staged
		mu.Unlock()
		if got {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the stage request did not arrive")
		}
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:已暂存 1")) > 0 })
	app.Type("id:mobile-git-message", "phone commit")
	app.Press("id:mobile-git-commit")
	deadline = time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		got := committed
		mu.Unlock()
		if got == "phone commit" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("commit message = %q", got)
		}
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
}
