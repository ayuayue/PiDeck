//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
)

// handler routes the phone's small API.
func (h *remoteHost) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", h.handlePing)
	mux.HandleFunc("/api/state", h.handleState)
	mux.HandleFunc("/api/session/", h.handleSession)
	mux.HandleFunc("/api/sessions", h.handleCreateSession)
	mux.HandleFunc("/api/agents", h.handleAgents)
	mux.HandleFunc("/api/tasks", h.handleTasks)
	mux.HandleFunc("/api/tasks/", h.handleTaskAction)
	mux.HandleFunc("/api/favorites", h.handleFavorites)
	mux.HandleFunc("/api/search", h.handleSearch)
	mux.HandleFunc("/api/projects", h.handleProject)
	mux.HandleFunc("/api/files", h.handleFiles)
	mux.HandleFunc("/api/file", h.handleFile)
	mux.HandleFunc("/api/git", h.handleGit)
	mux.HandleFunc("/api/git/diff", h.handleGitDiff)
	mux.HandleFunc("/api/git/stage", h.handleGitStage)
	mux.HandleFunc("/api/git/commit", h.handleGitCommit)
	mux.HandleFunc("/api/git/checkout", h.handleGitCheckout)
	mux.HandleFunc("/api/git/sync", h.handleGitSync)
	mux.HandleFunc("/api/sessions/", h.handleSessionAction)
	mux.HandleFunc("/api/feishu", h.handleFeishu)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		// The page and its wasm are public; the API below takes the token.
		if serveWebAsset(w, r) {
			return
		}
		// Feishu authenticates with its own verification token.
		if r.URL.Path == "/api/feishu" {
			mux.ServeHTTP(w, r)
			return
		}
		if !remoteAuthorized(r, h.currentToken()) {
			writeRemoteJSON(w, http.StatusUnauthorized, map[string]string{"error": "访问令牌无效"})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (h *remoteHost) handlePing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	host, _ := os.Hostname()
	writeRemoteJSON(w, http.StatusOK, map[string]any{
		"name": "PiDeck Lite", "version": pideckVersion, "host": host, "os": runtime.GOOS,
	})
}

func (h *remoteHost) handleState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	state, err := h.app.remoteSnapshot()
	if err != nil {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	writeRemoteJSON(w, http.StatusOK, state)
}

func (h *remoteHost) handleSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/session/")
	if strings.HasSuffix(rest, "/options") {
		id, err := url.PathUnescape(strings.TrimSuffix(rest, "/options"))
		if err != nil || id == "" {
			writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少会话 ID"})
			return
		}
		h.sessionOptions(w, id)
		return
	}
	id, err := url.PathUnescape(rest)
	if err != nil || id == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少会话 ID"})
		return
	}
	transcript, err := h.app.remoteTranscript(id)
	if err != nil {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeRemoteJSON(w, http.StatusOK, transcript)
}

func writeRemoteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// decodeRemoteBody reads a small JSON request body.
func decodeRemoteBody(r *http.Request, out any) error {
	return decodeRemoteBodyLimit(r, out, 1<<20)
}

// decodeRemoteBodyLimit reads a request body up to limit bytes; a prompt
// carrying images is far bigger than the rest.
func decodeRemoteBodyLimit(r *http.Request, out any, limit int64) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, limit))
	if err != nil {
		return errors.New("读取请求失败")
	}
	if len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return errors.New("请求格式不对")
	}
	return nil
}
