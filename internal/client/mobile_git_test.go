package client

// Checks the phone's read-only Git sheet against a fake desktop.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileGit(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	const token = "phone-token"
	state := remotewire.Snapshot{Name: "PiDeck V2", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目", Sessions: []remotewire.Session{{ID: "s1", Title: "电脑上的会话"}},
	}}}
	var mu sync.Mutex
	staged := false
	committed := ""
	branch := "main"
	checkedOut := ""
	synced := ""
	repo := remotewire.Git{IsRepo: true, Branch: "main", Upstream: "origin/main", Ahead: 1,
		Branches: []string{"main", "feature"},
		Files:    []remotewire.GitFile{{Path: "src/app.ts", Mark: "M"}},
		Commits:  []remotewire.Commit{{Hash: "0123456789abcdef", Short: "0123456", Subject: "第一次提交", Author: "Dev", When: "2026-06-01"}}}
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
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "PiDeck V2", "host": "desk"})
		}
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(state)
		}
	})
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(remotewire.Transcript{ID: "s1", Title: "电脑上的会话"})
		}
	})
	mux.HandleFunc("/api/git", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			mu.Lock()
			out := repo
			out.Files = append([]remotewire.GitFile(nil), repo.Files...)
			out.Files[0].Staged = staged
			out.Branch = branch
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
	mux.HandleFunc("/api/git/checkout", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		var body struct {
			Branch string `json:"branch"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		checkedOut, branch = body.Branch, body.Branch
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/git/sync", func(w http.ResponseWriter, r *http.Request) {
		if !check(w, r) {
			return
		}
		var body struct {
			Action string `json:"action"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		synced = body.Action
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
		committed, staged = body.Message, false
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/git/diff", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(map[string]string{"patch": "diff --git a/a.txt b/a.txt\n" +
				"--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old line\n+new line\n"})
		}
	})
	server := httptest.NewServer(mux)
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
	app.WaitFor("id:mobile-project-more-0", 10*time.Second)
	app.Press("id:mobile-project-more-0")
	app.WaitFor("id:mobile-project-sheet", 5*time.Second)
	app.Press("id:mobile-project-git")
	for i := 0; i < 4; i++ {
		if waitQuiet(app, "id:mobile-git", 2*time.Second) {
			break
		}
	}
	waitApp(app, "id:mobile-git", 10*time.Second)
	waitApp(app, "text:main", 5*time.Second)
	app.WaitFor("id:mobile-git-file-0", 5*time.Second)
	app.WaitFor("text:第一次提交", 5*time.Second)
	for i := 0; i < 4; i++ {
		app.Press("id:mobile-git-file-0")
		if waitQuiet(app, "id:mobile-git-diff", 2*time.Second) {
			break
		}
	}
	waitApp(app, "id:mobile-git-diff", 10*time.Second)
	// The patch is the desktop's diff view, not a block of plain text.
	app.WaitFor("id:mobile-git-diff-body", 5*time.Second)
	app.WaitUntil(5*time.Second, func() bool {
		return len(app.Query("text:new line")) > 0 && len(app.Query("text:old line")) > 0
	})
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

	// Switch branches from the sheet, then fetch. The sheet rebuilds after
	// the commit, so the press is retried if it lands mid-layout.
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:已暂存 0")) > 0 })
	for i := 0; i < 3; i++ {
		app.Press("id:mobile-git-branches")
		if waitQuiet(app, "id:mobile-git-branches-sheet", 3*time.Second) {
			break
		}
	}
	app.WaitFor("id:mobile-git-branches-sheet", 10*time.Second)
	app.Press("id:mobile-git-branch-1")
	deadline = time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		got := checkedOut
		mu.Unlock()
		if got == "feature" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("checkout = %q", got)
		}
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
	waitApp(app, "text:feature", 10*time.Second)
	app.Press("id:mobile-git-fetch")
	deadline = time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		got := synced
		mu.Unlock()
		if got == "fetch" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("sync = %q", got)
		}
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
}
