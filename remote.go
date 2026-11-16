//go:build !js && !android && !ios

package main

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"

	"github.com/nsgo-dev/nsgo/core"
)

const (
	defaultRemotePort = 8787
	pideckVersion     = "0.2.0"
)

// remoteLANAddress is one address the phone can reach this machine at.
type remoteLANAddress struct {
	Address   string `json:"address"`
	Interface string `json:"interface"`
	Private   bool   `json:"private"`
}

// remoteChannel is what one private network can offer.
type remoteChannel struct {
	Installed bool   `json:"installed"`
	Ready     bool   `json:"ready"`
	Address   string `json:"address"`
	Detail    string `json:"detail"`
	Error     string `json:"error"`
}

// remoteView is the settings page's snapshot.
type remoteView struct {
	Enabled   bool               `json:"enabled"`
	Running   bool               `json:"running"`
	Port      int                `json:"port"`
	Token     string             `json:"token"`
	Error     string             `json:"error"`
	Detecting bool               `json:"detecting"`
	LAN       []remoteLANAddress `json:"lan"`
	Tailscale remoteChannel      `json:"tailscale"`
	EasyTier  remoteChannel      `json:"easytier"`
}

// remoteHost owns the HTTP server, the token and the network scan.
type remoteHost struct {
	app   *app
	state *core.Signal[remoteView]

	mu        sync.Mutex
	srv       *http.Server
	port      int
	token     string
	running   bool
	err       string
	detecting bool
	search    *searchCache
}

// newRemoteHost builds the state from the config.
func newRemoteHost(a *app) *remoteHost {
	port := a.cfg.RemotePort
	if port == 0 {
		port = defaultRemotePort
	}
	return &remoteHost{
		app: a,
		state: core.NewSignalFunc(a.cx, remoteView{
			Enabled: a.cfg.RemoteEnabled, Port: port, Token: a.cfg.RemoteToken,
		}, nil),
		port: port, token: a.cfg.RemoteToken,
	}
}

// init starts the configured server and scans the networks.
func (h *remoteHost) init() {
	h.app.cx.Cleanup(h.close)
	if h.app.cfg.RemoteEnabled {
		h.ensureToken()
		h.start()
		h.refresh()
	}
}

// ensureToken generates the first token and persists it.
func (h *remoteHost) ensureToken() string {
	h.mu.Lock()
	token := h.token
	h.mu.Unlock()
	if token != "" {
		return token
	}
	token = randomToken()
	h.mu.Lock()
	h.token = token
	h.mu.Unlock()
	h.app.cfg.RemoteToken = token
	h.app.st.edit(func(c *config) { c.RemoteToken = token })
	h.state.Update(func(v remoteView) remoteView { v.Token = token; return v })
	return token
}

// setEnabled starts or stops the server.
func (h *remoteHost) setEnabled(on bool) {
	if on {
		h.ensureToken()
	}
	h.app.cfg.RemoteEnabled = on
	h.app.st.edit(func(c *config) { c.RemoteEnabled = on })
	if on {
		h.start()
		h.refresh()
	} else {
		h.stop()
	}
	h.state.Update(func(v remoteView) remoteView { v.Enabled = on; return v })
}

// setPort changes the listening port and restarts a running server.
func (h *remoteHost) setPort(port int) {
	if port < 1024 || port > 65535 {
		return
	}
	h.mu.Lock()
	if h.port == port {
		h.mu.Unlock()
		return
	}
	h.port = port
	restart := h.running
	h.mu.Unlock()
	h.app.cfg.RemotePort = port
	h.app.st.edit(func(c *config) { c.RemotePort = port })
	h.state.Update(func(v remoteView) remoteView { v.Port = port; return v })
	if restart {
		h.start()
	}
}

// setEasyTierIP stores the address the CLI could not read.
func (h *remoteHost) setEasyTierIP(ip string) {
	ip = normalizeIPv4(ip)
	h.app.cfg.RemoteEasyTierIP = ip
	h.app.st.edit(func(c *config) { c.RemoteEasyTierIP = ip })
	h.refresh()
}

// rotateToken replaces the token; phones with the old one lose access.
func (h *remoteHost) rotateToken() {
	token := randomToken()
	h.mu.Lock()
	h.token = token
	h.mu.Unlock()
	h.app.cfg.RemoteToken = token
	h.app.st.edit(func(c *config) { c.RemoteToken = token })
	h.state.Update(func(v remoteView) remoteView { v.Token = token; return v })
}

// currentToken is the token a request must present.
func (h *remoteHost) currentToken() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.token
}

// endpoint is the port and token a test or the settings page can use.
func (h *remoteHost) endpoint() (int, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.port, h.token
}

// link is the URL a phone opens for an address on one of the channels.
func (h *remoteHost) link(ip string) string {
	h.mu.Lock()
	port, token := h.port, h.token
	h.mu.Unlock()
	return remoteLink(ip, port, token)
}

func remoteLink(ip string, port int, token string) string {
	host := net.JoinHostPort(ip, strconv.Itoa(port))
	return "http://" + host + "/?token=" + url.QueryEscape(token)
}

// start listens on every interface.
func (h *remoteHost) start() {
	h.stop()
	h.mu.Lock()
	port := h.port
	h.mu.Unlock()
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		h.mu.Lock()
		h.running, h.err = false, "端口被占用或不可用："+err.Error()
		h.mu.Unlock()
		h.publish()
		return
	}
	actual := port
	if addr, ok := ln.Addr().(*net.TCPAddr); ok {
		actual = addr.Port
	}
	srv := &http.Server{
		Handler:           h.handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	h.mu.Lock()
	h.port, h.running, h.err, h.srv = actual, true, "", srv
	h.mu.Unlock()
	go func() {
		err := srv.Serve(ln)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			h.app.cx.Post(func() {
				h.mu.Lock()
				h.running, h.err = false, err.Error()
				h.mu.Unlock()
				h.publish()
			})
		}
	}()
	h.publish()
}

// stop closes the listening socket and every phone connection.
func (h *remoteHost) stop() {
	h.mu.Lock()
	srv := h.srv
	h.srv = nil
	h.running = false
	h.mu.Unlock()
	if srv != nil {
		_ = srv.Close()
	}
	h.publish()
}

// close ends the server without touching the UI, for the app's end.
func (h *remoteHost) close() {
	h.mu.Lock()
	srv := h.srv
	h.srv = nil
	h.running = false
	h.mu.Unlock()
	if srv != nil {
		_ = srv.Close()
	}
}

// publish copies the server's runtime fields into the view signal.
func (h *remoteHost) publish() {
	h.mu.Lock()
	running, port, token, errText := h.running, h.port, h.token, h.err
	h.mu.Unlock()
	h.state.Update(func(v remoteView) remoteView {
		v.Running, v.Port, v.Token, v.Error = running, port, token, errText
		return v
	})
}

// refresh scans the three channels in the background.
func (h *remoteHost) refresh() {
	h.mu.Lock()
	if h.detecting {
		h.mu.Unlock()
		return
	}
	h.detecting = true
	manualIP := h.app.cfg.RemoteEasyTierIP
	h.mu.Unlock()
	h.state.Update(func(v remoteView) remoteView { v.Detecting = true; return v })
	go func() {
		lan := detectLAN()
		ts := probeTailscale()
		et := probeEasyTier(manualIP)
		h.app.cx.Post(func() {
			h.state.Update(func(v remoteView) remoteView {
				v.LAN, v.Tailscale, v.EasyTier, v.Detecting = lan, ts, et, false
				return v
			})
			h.mu.Lock()
			h.detecting = false
			h.mu.Unlock()
		})
	}()
}

// handler routes the phone's small API.
func (h *remoteHost) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", h.handlePing)
	mux.HandleFunc("/api/state", h.handleState)
	mux.HandleFunc("/api/session/", h.handleSession)
	mux.HandleFunc("/api/sessions", h.handleCreateSession)
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

// remoteGitOf maps the drawer's state to the wire.
func remoteGitOf(st gitState) remoteWireGit {
	out := remoteWireGit{IsRepo: st.IsRepo, Branch: st.Branch, Upstream: st.Upstream,
		Ahead: st.Ahead, Behind: st.Behind, Branches: append([]string(nil), st.Branches...), Error: st.Error}
	for _, f := range st.Files {
		out.Files = append(out.Files, remoteWireGitFile{Path: f.Path, Mark: f.mark(), Staged: f.staged()})
	}
	for i, c := range st.Commits {
		if i >= 20 {
			break
		}
		when := ""
		if !c.Date.IsZero() {
			when = c.Date.Format("2006-01-02")
		}
		out.Commits = append(out.Commits, remoteWireCommit{Hash: c.Hash, Short: c.Short, Subject: c.Subject, Author: c.Author, When: when})
	}
	return out
}

// searchCache keeps each session file's text so a second search is cheap.
type searchCache struct {
	mu      sync.Mutex
	entries map[string]searchEntry
}

type searchEntry struct {
	mod  time.Time
	size int64
	text string
}

// handleSearch looks for a word in the messages of every session file.
func (h *remoteHost) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if len([]rune(query)) < 2 {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "至少输入两个字"})
		return
	}
	project := r.URL.Query().Get("project")

	type target struct {
		id, title, project, file string
	}
	var targets []target
	ok := h.app.withUI(func() {
		for _, ws := range h.app.workspaces.GetUntracked() {
			if ws.Target.remote() || (project != "" && ws.Path != project) {
				continue
			}
			h.app.scanProject(ws)
			pinned, rest := h.app.projectSessions(ws)
			for _, s := range append(pinned, rest...) {
				if s == nil || s.File == "" {
					continue
				}
				targets = append(targets, target{id: s.ID, title: s.title.Get(), project: ws.label(), file: s.File})
			}
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}

	hits := make([]remoteWireHit, 0, 20)
	for _, t := range targets {
		if len(hits) >= 30 {
			break
		}
		text := h.searchText(t.file)
		if text == "" {
			continue
		}
		at := strings.Index(text, query)
		if at < 0 {
			continue
		}
		hits = append(hits, remoteWireHit{Session: t.id, Title: t.title, Project: t.project, Snippet: snippetAround(text, at, query)})
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"hits": hits})
}

// searchText is a session file's messages, lowercased, kept between calls.
func (h *remoteHost) searchText(file string) string {
	info, err := os.Stat(file)
	if err != nil {
		return ""
	}
	if h.search == nil {
		h.search = &searchCache{entries: map[string]searchEntry{}}
	}
	h.search.mu.Lock()
	entry, ok := h.search.entries[file]
	h.search.mu.Unlock()
	if ok && entry.mod.Equal(info.ModTime()) && entry.size == info.Size() {
		return entry.text
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	if len(raw) > 4<<20 {
		raw = raw[:4<<20]
	}
	var b strings.Builder
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for sc.Scan() {
		var entry struct {
			Type    string          `json:"type"`
			Message json.RawMessage `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &entry) != nil || entry.Type != "message" {
			continue
		}
		var msg piMessage
		if json.Unmarshal(entry.Message, &msg) != nil {
			continue
		}
		b.WriteString(msg.text())
		b.WriteByte(10)
		if b.Len() > 400<<10 {
			break
		}
	}
	text := strings.ToLower(b.String())
	h.search.mu.Lock()
	h.search.entries[file] = searchEntry{mod: info.ModTime(), size: info.Size(), text: text}
	h.search.mu.Unlock()
	return text
}

// snippetAround is the text around a match, on one line.
func snippetAround(text string, at int, query string) string {
	start := at - 40
	if start < 0 {
		start = 0
	}
	end := at + len(query) + 60
	if end > len(text) {
		end = len(text)
	}
	cut := text[start:end]
	cut = strings.Join(strings.Fields(cut), " ")
	if start > 0 {
		cut = "…" + cut
	}
	if end < len(text) {
		cut += "…"
	}
	return cut
}

// qrPNGFor encodes a link as a QR code image.
func qrPNGFor(link string) []byte {
	if link == "" {
		return nil
	}
	png, err := qrcode.Encode(link, qrcode.Medium, 480)
	if err != nil {
		return nil
	}
	return png
}

// handleProject adds or removes a project folder on the desktop.
func (h *remoteHost) handleProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Path   string `json:"path"`
		Remove bool   `json:"remove"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	path := strings.TrimSpace(body.Path)
	if path == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少文件夹路径"})
		return
	}
	if body.Remove {
		var failure error
		ok := h.app.withUI(func() {
			ws := h.app.workspaceOf(path)
			if ws == nil {
				failure = errors.New("找不到这个项目")
				return
			}
			h.app.removeWorkspaceNow(ws)
		})
		h.finishAction(w, ok, failure, map[string]any{"ok": true})
		return
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "电脑上找不到这个文件夹"})
		return
	}
	var failure error
	ok := h.app.withUI(func() { h.app.addWorkspace(path) })
	h.finishAction(w, ok, failure, map[string]any{"ok": true, "name": filepath.Base(path)})
}

// handleCreateSession starts a session in one of the projects.
func (h *remoteHost) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Project string `json:"project"`
		Title   string `json:"title"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	project := strings.TrimSpace(body.Project)
	var id, title string
	var failure error
	ok := h.app.withUI(func() {
		ws := h.app.workspaceOf(project)
		if ws == nil {
			failure = errors.New("找不到这个项目")
			return
		}
		s := h.app.newSession(ws.Path)
		if s == nil {
			failure = errors.New("新建会话失败")
			return
		}
		if name := strings.TrimSpace(body.Title); name != "" {
			s.title.Set(name)
			if h.app.st != nil {
				h.app.st.edit(func(c *config) { c.Titles[s.ID] = name })
			}
		}
		id, title = s.ID, s.title.Get()
	})
	switch {
	case !ok:
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
	case failure != nil:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": failure.Error()})
	default:
		writeRemoteJSON(w, http.StatusOK, map[string]string{"id": id, "title": title})
	}
}

// handleSessionAction runs one operation on a session.
func (h *remoteHost) handleSessionAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	parts := strings.SplitN(rest, "/", 2)
	id, err := url.PathUnescape(parts[0])
	if err != nil || id == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少会话 ID"})
		return
	}
	action := ""
	if len(parts) == 2 {
		action = strings.Trim(parts[1], "/")
	}
	switch action {
	case "prompt":
		h.sessionPrompt(w, r, id)
	case "stop":
		h.sessionStop(w, id)
	case "rename":
		h.sessionRename(w, r, id)
	case "pin":
		h.sessionPin(w, r, id)
	case "model":
		h.sessionModel(w, r, id)
	case "thinking":
		h.sessionThinking(w, r, id)
	case "delete":
		h.sessionDelete(w, id)
	case "answer":
		h.sessionAnswer(w, r, id)
	default:
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "没有这个操作"})
	}
}

// sessionPrompt sends one message into a session, starting pi when the
// session was never opened on the desktop.
func (h *remoteHost) sessionPrompt(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Text   string `json:"text"`
		Images []struct {
			Mime string `json:"mime"`
			Data string `json:"data"`
		} `json:"images"`
	}
	if err := decodeRemoteBodyLimit(r, &body, 48<<20); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	text := strings.TrimSpace(body.Text)
	switch {
	case text == "" && len(body.Images) == 0:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "消息不能为空"})
		return
	case len([]rune(text)) > 20000:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "消息太长了"})
		return
	case len(body.Images) > 4:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "一次最多 4 张图片"})
		return
	}
	var images []promptImage
	for _, raw := range body.Images {
		data, err := base64.StdEncoding.DecodeString(raw.Data)
		if err != nil || len(data) == 0 {
			writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "图片数据不对"})
			return
		}
		if len(data) > 6<<20 {
			writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "单张图片不能超过 6 MB"})
			return
		}
		mime := strings.TrimSpace(raw.Mime)
		if mime == "" {
			mime = "image/png"
		}
		images = append(images, promptImage{Data: data, MimeType: mime, Name: "phone"})
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		if ws := h.app.workspaceOf(s.WS); ws != nil && !h.app.projectTrusted(ws) {
			failure = errors.New(T("这个项目还没有在电脑上被信任"))
			return
		}
		// A message for a turn that is still running steers it, as the
		// desktop's composer does.
		if s.busyNow() {
			h.app.steer(s, text, images)
			return
		}
		h.app.submit(s, text, images)
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// sessionStop aborts the running turn.
func (h *remoteHost) sessionStop(w http.ResponseWriter, id string) {
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		if s.busyNow() {
			h.app.stop(s)
		}
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// handleGit reads a local project's repository for the phone.
func (h *remoteHost) handleGit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	project := r.URL.Query().Get("project")
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	writeRemoteJSON(w, http.StatusOK, remoteGitOf(readGitState(localTarget, path, 1)))
}

// projectPath resolves a request's project to a local folder.
func (h *remoteHost) projectPath(project string) (string, bool) {
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	return path, ok
}

// remoteFileMax is the largest file the phone may read.
const remoteFileMax = 512 << 10

// handleFiles lists a project's files for the phone, flat and sorted.
func (h *remoteHost) handleFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	root, ok := h.projectPath(r.URL.Query().Get("project"))
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if root == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	files := walkWorkspaceFiles(root)
	sort.Strings(files)
	out := make([]remoteWireFile, 0, len(files))
	for _, rel := range files {
		var size int64
		if info, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err == nil {
			size = info.Size()
		}
		out = append(out, remoteWireFile{Path: rel, Size: size})
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"files": out})
}

// handleFile reads one file's text, refusing what the editor refuses too.
func (h *remoteHost) handleFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	root, ok := h.projectPath(r.URL.Query().Get("project"))
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if root == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	rel := r.URL.Query().Get("path")
	full, ok := fileWithin(root, rel)
	if !ok {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "路径不在这个项目里"})
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个文件"})
		return
	}
	if info.Size() > remoteFileMax {
		writeRemoteJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "文件太大，手机上只读 512 KB 以内的文件"})
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个文件"})
		return
	}
	if bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
		writeRemoteJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "这是二进制文件，不能当文本读"})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"path": filepath.ToSlash(filepath.Clean(filepath.FromSlash(rel))), "text": string(data), "size": info.Size()})
}

// fileWithin resolves a request's relative path inside a root, refusing
// anything that leaves it.
func fileWithin(root, rel string) (string, bool) {
	rel = strings.TrimSpace(rel)
	if rel == "" {
		return "", false
	}
	clean := filepath.Clean(filepath.FromSlash(rel))
	if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", false
	}
	full := filepath.Join(root, clean)
	if inside, err := filepath.Rel(root, full); err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return "", false
	}
	return full, true
}

// handleGitDiff reads one changed file's patch. Only paths the repository
// reports are accepted, so a request cannot walk outside the project.
func (h *remoteHost) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	project := r.URL.Query().Get("project")
	rel := r.URL.Query().Get("path")
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	st := readGitState(localTarget, path, 1)
	var file *gitFile
	for i := range st.Files {
		if st.Files[i].Path == rel {
			file = &st.Files[i]
			break
		}
	}
	if file == nil {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "没有这个改动"})
		return
	}
	var args []string
	switch {
	case file.Untracked:
		args = []string{"diff", "--no-index", "--no-color", "--", "/dev/null", file.Path}
	case file.staged():
		args = []string{"diff", "--cached", "--no-color", "--", file.Path}
	default:
		args = []string{"diff", "--no-color", "--", file.Path}
	}
	out, stderr, code, err := gitRun(localTarget, path, 40*time.Second, args...)
	if err != nil {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if code != 0 && strings.TrimSpace(out) == "" {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": firstLine(stderr, 200)})
		return
	}
	const limit = 512 << 10
	if len(out) > limit {
		out = out[:limit] + "\n… 补丁过长，已截断"
	}
	writeRemoteJSON(w, http.StatusOK, map[string]string{"patch": out})
}

// handleGitStage stages or unstages one changed path.
func (h *remoteHost) handleGitStage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Project string `json:"project"`
		Path    string `json:"path"`
		Stage   bool   `json:"stage"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(body.Project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	st := readGitState(localTarget, path, 1)
	known := false
	for _, f := range st.Files {
		if f.Path == body.Path {
			known = true
			break
		}
	}
	if !known {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "没有这个改动"})
		return
	}
	var args []string
	if body.Stage {
		args = []string{"add", "--", body.Path}
	} else {
		args = []string{"restore", "--staged", "--", body.Path}
	}
	_, stderr, code, err := gitRun(localTarget, path, 60*time.Second, args...)
	if err == nil && code != 0 && !body.Stage {
		// An unborn branch has no HEAD for restore; take it out of the
		// index instead, as the desktop does.
		_, stderr, code, err = gitRun(localTarget, path, 60*time.Second, "rm", "--cached", "-r", "-q", "--", body.Path)
	}
	if err != nil {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if code != 0 {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": firstLine(stderr, 200)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleGitCommit commits what is staged. It never discards anything, so
// it is safe to expose to the phone with the same token as the rest.
func (h *remoteHost) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Project string `json:"project"`
		Message string `json:"message"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	msg := strings.TrimSpace(body.Message)
	switch {
	case msg == "":
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "提交说明不能为空"})
		return
	case len([]rune(msg)) > 500:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "提交说明太长了"})
		return
	}
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(body.Project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	_, stderr, code, err := gitRun(localTarget, path, 180*time.Second, "commit", "-m", msg)
	if err != nil {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if code != 0 {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": firstLine(stderr, 240)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleGitCheckout switches to a local branch.
func (h *remoteHost) handleGitCheckout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Project string `json:"project"`
		Branch  string `json:"branch"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(body.Project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	st := readGitState(localTarget, path, 1)
	known := false
	for _, b := range st.Branches {
		if b == body.Branch {
			known = true
			break
		}
	}
	if !known {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "没有这个分支"})
		return
	}
	if st.Branch == body.Branch {
		writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	_, stderr, code, err := gitRun(localTarget, path, 60*time.Second, "checkout", body.Branch)
	if err != nil {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if code != 0 {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": firstLine(stderr, 240)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleGitSync fetches, pulls or pushes, whichever the phone asked for.
func (h *remoteHost) handleGitSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Project string `json:"project"`
		Action  string `json:"action"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var args []string
	switch body.Action {
	case "fetch":
		args = []string{"fetch", "--all", "--prune"}
	case "pull":
		args = []string{"pull"}
	case "push":
		args = []string{"push"}
	default:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "不认识的同步动作"})
		return
	}
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(body.Project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	_, stderr, code, err := gitRun(localTarget, path, 180*time.Second, args...)
	if err != nil {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if code != 0 {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": firstLine(stderr, 240)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// sessionAnswer answers the question a session is waiting on, so a turn
// that needs approval can finish while the user is away from the desk.
func (h *remoteHost) sessionAnswer(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Confirmed *bool  `json:"confirmed"`
		Value     string `json:"value"`
		Cancelled bool   `json:"cancelled"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		ask := s.ask.GetUntracked()
		if ask == nil {
			failure = errors.New("这个会话没有等待回答")
			return
		}
		value := map[string]any{}
		switch ask.Method {
		case "confirm":
			if body.Confirmed == nil {
				failure = errors.New("缺少 confirmed")
				return
			}
			value["confirmed"] = *body.Confirmed
		case "select":
			if body.Cancelled {
				value["cancelled"] = true
				break
			}
			known := false
			for _, opt := range ask.Options {
				if opt == body.Value {
					known = true
					break
				}
			}
			if !known {
				failure = errors.New("这个选项不存在")
				return
			}
			value["value"] = body.Value
		case "input", "editor":
			if body.Cancelled {
				value["cancelled"] = true
				break
			}
			if strings.TrimSpace(body.Value) == "" {
				failure = errors.New("缺少回答内容")
				return
			}
			value["value"] = body.Value
		default:
			value["cancelled"] = true
		}
		h.app.answerAsk(s, value)
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// sessionRename sets a session's name, here and in pi.
func (h *remoteHost) sessionRename(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Title string `json:"title"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	name := strings.TrimSpace(body.Title)
	switch {
	case name == "":
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "名字不能为空"})
		return
	case len([]rune(name)) > 80:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "名字太长了"})
		return
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		s.title.Set(name)
		if h.app.st != nil {
			h.app.st.edit(func(c *config) { c.Titles[s.ID] = name })
		}
		if s.engine != nil {
			go func(c *piClient) {
				_ = c.call(map[string]any{"type": "set_session_name", "name": name}, nil, 10*time.Second)
			}(s.engine)
		}
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true, "title": name})
}

// sessionPin pins or unpins a session in the rail.
func (h *remoteHost) sessionPin(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Pinned *bool `json:"pinned"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		want := !h.app.isPinned(id)
		if body.Pinned != nil {
			want = *body.Pinned
		}
		if h.app.isPinned(id) != want {
			h.app.togglePin(s)
		}
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// sessionDelete removes a session and moves its file to the trash.
func (h *remoteHost) sessionDelete(w http.ResponseWriter, id string) {
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		if s.External {
			failure = errors.New("这是 pi 自己的会话，不能在手机上删除")
			return
		}
		h.app.removeSession(s)
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// sessionOptions lists the models and levels of a session, starting pi
// when it is not up yet.
func (h *remoteHost) sessionOptions(w http.ResponseWriter, id string) {
	var out remoteWireOptions
	var found bool
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			return
		}
		found = true
		current := s.model.GetUntracked()
		out.Model, out.Provider, out.Thinking = current.ID, current.Provider, s.thinking.GetUntracked()
		for _, m := range s.models.GetUntracked() {
			out.Models = append(out.Models, remoteWireModel{ID: m.ID, Name: m.label(), Provider: m.Provider, Reasoning: m.Reasoning})
		}
		out.Levels = append([]string(nil), s.levels.GetUntracked()...)
		out.Ready = s.readySig.GetUntracked()
		if !out.Ready {
			h.app.ensureEngine(s, nil)
		}
	})
	switch {
	case !ok:
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
	case !found:
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个会话"})
	default:
		writeRemoteJSON(w, http.StatusOK, out)
	}
}

// sessionModel switches the model of a session.
func (h *remoteHost) sessionModel(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		ID       string `json:"id"`
		Provider string `json:"provider"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if strings.TrimSpace(body.ID) == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少模型 ID"})
		return
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		h.app.applyModel(s, body.Provider, body.ID, false)
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// sessionThinking switches the reasoning level of a session.
func (h *remoteHost) sessionThinking(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Level string `json:"level"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	level := strings.TrimSpace(body.Level)
	if level == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少思考等级"})
		return
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		h.app.applyThinking(s, level, false)
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// finishAction writes the outcome of a UI-thread action.
func (h *remoteHost) finishAction(w http.ResponseWriter, ok bool, failure error, body map[string]any) {
	switch {
	case !ok:
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
	case failure != nil:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": failure.Error()})
	default:
		writeRemoteJSON(w, http.StatusOK, body)
	}
}

// remoteAuthorized checks the bearer token, or a GET's token query, in
// constant time.
func remoteAuthorized(r *http.Request, token string) bool {
	if token == "" {
		return false
	}
	given := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if given == "" && r.Method == http.MethodGet {
		given = r.URL.Query().Get("token")
	}
	return subtle.ConstantTimeCompare([]byte(given), []byte(token)) == 1
}

func randomToken() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// --- the phone's data ----------------------------------------------------

// remoteAskOf is the question a session is waiting on, if any.
func remoteAskOf(s *session) *remoteWireAsk {
	ask := s.ask.GetUntracked()
	if ask == nil {
		return nil
	}
	return &remoteWireAsk{Method: ask.Method, Title: ask.Title, Message: ask.Message,
		Options: append([]string(nil), ask.Options...)}
}

// remoteSnapshot reads the projects and sessions on the UI thread.
func (a *app) remoteSnapshot() (remoteWireSnapshot, error) {
	var out remoteWireSnapshot
	host, _ := os.Hostname()
	out.Name, out.Version, out.Host = "PiDeck Lite", pideckVersion, host
	ok := a.withUI(func() {
		for _, ws := range a.workspaces.GetUntracked() {
			if ws.Target.remote() {
				continue
			}
			a.scanProject(ws)
			pinned, rest := a.projectSessions(ws)
			project := remoteWireProject{Path: ws.Path, Name: ws.label()}
			for _, s := range append(pinned, rest...) {
				if s == nil {
					continue
				}
				stats := s.stats.Get()
				usage := s.usage.Get()
				project.Sessions = append(project.Sessions, remoteWireSession{
					ID: s.ID, Title: s.title.Get(), Status: remoteStatus(s.status.Get()),
					Updated: s.updated.Get().UnixMilli(), External: s.External,
					Pinned: a.isPinned(s.ID), Running: s.busyNow(), Ask: remoteAskOf(s),
					Tokens: usage.Total, Context: stats.ContextTokens, ContextWindow: stats.ContextWindow, Cost: usage.Cost,
				})
			}
			out.Projects = append(out.Projects, project)
		}
	})
	if !ok {
		return out, errors.New("界面正忙，请稍后再试")
	}
	return out, nil
}

func remoteStatus(s sessionStatus) string {
	switch s {
	case statusStarting:
		return "starting"
	case statusRunning:
		return "running"
	case statusWaiting:
		return "waiting"
	case statusFailed:
		return "failed"
	}
	return "idle"
}

// remoteTranscript reads one session's history, from memory when it is
// open and from its file otherwise.
func (a *app) remoteTranscript(id string) (remoteWireTranscript, error) {
	var out remoteWireTranscript
	var title, file string
	var turns []turn
	var found, loaded, running bool
	var live, liveThinking string
	var ask *remoteWireAsk
	ok := a.withUI(func() {
		s := a.byID[id]
		if s == nil {
			return
		}
		found, title, file, loaded = true, s.title.Get(), s.File, s.loaded.GetUntracked()
		running = s.busyNow()
		ask = remoteAskOf(s)
		live, liveThinking = s.streamText.GetUntracked(), s.streamThinking.GetUntracked()
		if loaded {
			turns = s.turns.GetUntracked()
		}
	})
	if !ok {
		return out, errors.New("界面正忙，请稍后再试")
	}
	if !found {
		return out, errors.New("找不到这个会话")
	}
	out.ID, out.Title, out.Ask = id, title, ask
	if !loaded {
		if file == "" {
			// A session that never ran has no file yet; that is empty, not
			// an error.
			return out, nil
		}
		history, err := readSessionTurns(file)
		if err != nil {
			out.Error = "读取会话失败：" + err.Error()
			return out, nil
		}
		turns = history
	}
	out.Messages = remoteMessages(turns)
	out.Running = running
	// The live buffers are what pi is saying right now; the turns only
	// carry what it has finished.
	if running {
		if thinking := strings.TrimSpace(liveThinking); thinking != "" {
			out.Messages = append(out.Messages, remoteWireMessage{Role: "thinking", Text: thinking})
		}
		if text := strings.TrimSpace(live); text != "" {
			last := len(out.Messages) > 0 && out.Messages[len(out.Messages)-1].Role == "assistant" &&
				out.Messages[len(out.Messages)-1].Text == text
			if !last {
				out.Messages = append(out.Messages, remoteWireMessage{Role: "assistant", Text: text})
			}
		}
	}
	return out, nil
}

// readSessionTurns reads the messages of a pi session file.
func readSessionTurns(path string) ([]turn, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	var msgs []piMessage
	for sc.Scan() {
		var entry struct {
			Type    string          `json:"type"`
			Message json.RawMessage `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &entry) != nil || entry.Type != "message" || len(entry.Message) == 0 {
			continue
		}
		var msg piMessage
		if json.Unmarshal(entry.Message, &msg) == nil {
			msgs = append(msgs, msg)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(msgs) > 4000 {
		msgs = msgs[len(msgs)-4000:]
	}
	return turnsFromMessages(msgs), nil
}

// remoteMessages flattens turns into the phone's chat lines: what the user
// asked, what pi thought and said, and the tools it named; output stays on
// the desktop.
func remoteMessages(turns []turn) []remoteWireMessage {
	var out []remoteWireMessage
	var size int
	add := func(role, text string) {
		text = strings.TrimSpace(text)
		if text == "" || size > 240_000 {
			return
		}
		if r := []rune(text); len(r) > 12_000 {
			text = string(r[:12_000]) + "…"
		}
		out = append(out, remoteWireMessage{Role: role, Text: text})
		size += len(text)
	}
	for _, t := range turns {
		prompt := t.Prompt
		if len(t.Images) > 0 {
			prompt = strings.TrimSpace(prompt + " ［图片］")
		}
		add("user", prompt)
		for _, step := range t.Steps {
			add("note", step.Note)
			add("thinking", step.Thinking)
			for _, tool := range step.Tools {
				line := strings.TrimSpace(tool.Action + " " + tool.Detail)
				add("tool", line)
			}
			add("assistant", step.Text)
		}
		if t.Final != "" {
			duplicate := len(out) > 0 && out[len(out)-1].Role == "assistant" && out[len(out)-1].Text == strings.TrimSpace(t.Final)
			if !duplicate {
				add("assistant", t.Final)
			}
		}
		add("error", t.Err)
	}
	return out
}

// withUI runs fn on the graph's goroutine, waiting briefly for it.
func (a *app) withUI(fn func()) bool {
	done := make(chan struct{})
	a.cx.Post(func() {
		defer close(done)
		fn()
	})
	select {
	case <-done:
		return true
	case <-time.After(3 * time.Second):
		return false
	}
}

// --- network channels ----------------------------------------------------

// detectLAN lists the non-loopback IPv4 addresses, private ones first.
func detectLAN() []remoteLANAddress {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []remoteLANAddress
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipnet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || seen[ip.String()] {
				continue
			}
			seen[ip.String()] = true
			out = append(out, remoteLANAddress{Address: ip.String(), Interface: iface.Name, Private: privateIPv4(ip)})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Private != out[j].Private {
			return out[i].Private
		}
		return out[i].Address < out[j].Address
	})
	return out
}

func privateIPv4(ip net.IP) bool {
	if len(ip) != 4 {
		return false
	}
	return ip[0] == 10 || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] == 192 && ip[1] == 168)
}

// probeTailscale reads the local tailnet address from the CLI.
func probeTailscale() remoteChannel {
	path := findTool("tailscale", []string{
		`C:\Program Files\Tailscale\tailscale.exe`, `C:\Program Files\Tailscale IPN\tailscale.exe`,
		"/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale",
		"/usr/bin/tailscale",
	})
	if path == "" {
		return remoteChannel{Detail: "未找到 tailscale CLI"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "status", "--json")
	hideWindow(cmd)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	out, err := cmd.Output()
	if err != nil {
		return remoteChannel{Installed: true, Error: firstLine(err.Error(), 160)}
	}
	var status struct {
		BackendState string `json:"BackendState"`
		Self         struct {
			TailscaleIPs []string `json:"TailscaleIPs"`
			DNSName      string   `json:"DNSName"`
		} `json:"Self"`
	}
	if json.Unmarshal(out, &status) != nil {
		return remoteChannel{Installed: true, Error: "tailscale status 没有返回 JSON"}
	}
	ip := ""
	for _, candidate := range status.Self.TailscaleIPs {
		if strings.Contains(candidate, ".") {
			ip = candidate
			break
		}
	}
	if status.BackendState != "Running" || ip == "" {
		detail := "状态：" + status.BackendState
		if status.BackendState == "" {
			detail = "tailscaled 未运行或未登录"
		}
		return remoteChannel{Installed: true, Detail: detail}
	}
	dns := strings.TrimSuffix(status.Self.DNSName, ".")
	detail := "Tailscale 已连接"
	if dns != "" {
		detail = dns
	}
	return remoteChannel{Installed: true, Ready: true, Address: ip, Detail: detail}
}

// probeEasyTier reads the virtual IPv4 of a running EasyTier node, with a
// manually entered address as the fallback.
func probeEasyTier(manual string) remoteChannel {
	manual = normalizeIPv4(manual)
	candidates := []string{
		`C:\Program Files\EasyTier\easytier-cli.exe`, `C:\Program Files\easytier\easytier-cli.exe`,
		`C:\Program Files\easytier-gui\easytier-cli.exe`,
	}
	for _, base := range []string{os.Getenv("LOCALAPPDATA"), os.Getenv("USERPROFILE"), os.Getenv("ProgramData")} {
		if base == "" {
			continue
		}
		candidates = append(candidates,
			filepath.Join(base, "Programs", "EasyTier", "easytier-cli.exe"),
			filepath.Join(base, "Microsoft", "WinGet", "Links", "easytier-cli.exe"),
			filepath.Join(base, "scoop", "shims", "easytier-cli.exe"),
			filepath.Join(base, "chocolatey", "bin", "easytier-cli.exe"))
	}
	path := findTool("easytier-cli", candidates)
	if path != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, path, "-o", "json", "node")
		hideWindow(cmd)
		if out, err := cmd.Output(); err == nil {
			if ch, ok := easyTierJSON(out); ok {
				return ch
			}
		}
		cmd = exec.CommandContext(ctx, path, "node")
		hideWindow(cmd)
		if out, err := cmd.Output(); err == nil {
			if ch, ok := easyTierTable(string(out)); ok {
				return ch
			}
		}
	}
	if manual != "" {
		return remoteChannel{Installed: path != "", Ready: true, Address: manual, Detail: "手动填写的 EasyTier 地址"}
	}
	if path == "" {
		return remoteChannel{Detail: "未找到 easytier-cli"}
	}
	return remoteChannel{Installed: true, Error: "EasyTier 节点没有运行，或 CLI 读不到虚拟地址"}
}

func easyTierJSON(out []byte) (remoteChannel, bool) {
	var value any
	if json.Unmarshal(out, &value) != nil {
		return remoteChannel{}, false
	}
	if list, ok := value.([]any); ok && len(list) > 0 {
		value = list[0]
	}
	for i := 0; i < 3; i++ {
		record, ok := value.(map[string]any)
		if !ok {
			return remoteChannel{}, false
		}
		if inner, ok := record["result"].(map[string]any); ok {
			value = inner
			continue
		}
		raw := stringField(record, "ipv4_addr", "ipv4Addr")
		ip := normalizeIPv4(raw)
		if ip == "" {
			return remoteChannel{}, false
		}
		detail := stringField(record, "hostname", "host_name")
		if version := stringField(record, "version"); version != "" {
			if detail != "" {
				detail += " · "
			}
			detail += version
		}
		if detail == "" {
			detail = "EasyTier 已连接"
		}
		return remoteChannel{Installed: true, Ready: true, Address: ip, Detail: detail}, true
	}
	return remoteChannel{}, false
}

func easyTierTable(out string) (remoteChannel, bool) {
	var ip, hostname string
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(line, "|")
		if len(fields) < 3 {
			continue
		}
		key, value := strings.TrimSpace(fields[1]), strings.TrimSpace(fields[2])
		switch key {
		case "Virtual IP":
			ip = normalizeIPv4(value)
		case "Hostname":
			hostname = value
		}
	}
	if ip == "" {
		return remoteChannel{}, false
	}
	detail := "EasyTier 已连接"
	if hostname != "" {
		detail = hostname
	}
	return remoteChannel{Installed: true, Ready: true, Address: ip, Detail: detail}, true
}

func stringField(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// normalizeIPv4 accepts an address with an optional CIDR suffix.
func normalizeIPv4(value string) string {
	value = strings.TrimSpace(strings.Split(value, "/")[0])
	ip := net.ParseIP(value)
	if ip == nil {
		return ""
	}
	v4 := ip.To4()
	if v4 == nil || v4.IsUnspecified() || v4.Equal(net.IPv4bcast) {
		return ""
	}
	return v4.String()
}

// findTool looks in PATH and the usual install places.
func findTool(name string, candidates []string) string {
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	if runtime.GOOS == "windows" {
		exe := name
		if filepath.Ext(exe) == "" {
			exe += ".exe"
		}
		for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
			if base == "" {
				continue
			}
			for _, sub := range []string{"Programs\\EasyTier", "EasyTier", "easytier", "easytier-gui"} {
				candidates = append(candidates, filepath.Join(base, sub, exe))
			}
		}
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}
