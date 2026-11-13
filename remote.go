package main

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"bufio"
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

	"github.com/oneo-me/nsgo/core"
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
	mux.HandleFunc("/api/sessions/", h.handleSessionAction)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
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

// remoteWireModel is one model the phone can switch to.
type remoteWireModel struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	Reasoning bool   `json:"reasoning"`
}

// remoteWireOptions is a session's model and thinking choices.
type remoteWireOptions struct {
	Models   []remoteWireModel `json:"models"`
	Model    string            `json:"model"`
	Provider string            `json:"provider"`
	Thinking string            `json:"thinking"`
	Levels   []string          `json:"levels"`
	Ready    bool              `json:"ready"`
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

type remoteWireProject struct {
	Path     string              `json:"path"`
	Name     string              `json:"name"`
	Sessions []remoteWireSession `json:"sessions"`
}

type remoteWireSession struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Status   string `json:"status"`
	Updated  int64  `json:"updated"`
	External bool   `json:"external"`
	Pinned   bool   `json:"pinned"`
	Running  bool   `json:"running"`
}

type remoteWireSnapshot struct {
	Name     string              `json:"name"`
	Version  string              `json:"version"`
	Host     string              `json:"host"`
	Projects []remoteWireProject `json:"projects"`
}

type remoteWireMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

type remoteWireTranscript struct {
	ID       string              `json:"id"`
	Title    string              `json:"title"`
	Running  bool                `json:"running"`
	Messages []remoteWireMessage `json:"messages"`
	Error    string              `json:"error,omitempty"`
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
				project.Sessions = append(project.Sessions, remoteWireSession{
					ID: s.ID, Title: s.title.Get(), Status: remoteStatus(s.status.Get()),
					Updated: s.updated.Get().UnixMilli(), External: s.External,
					Pinned: a.isPinned(s.ID), Running: s.busyNow(),
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
	ok := a.withUI(func() {
		s := a.byID[id]
		if s == nil {
			return
		}
		found, title, file, loaded = true, s.title.Get(), s.File, s.loaded.GetUntracked()
		running = s.busyNow()
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
	out.ID, out.Title = id, title
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
