//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"golang.org/x/net/websocket"
)

const (
	defaultRemotePort = 8787
)

// remoteLANAddress is one address the phone can reach this machine at.
type remoteLANAddress struct {
	Address   string `json:"address"`
	Interface string `json:"interface"`
	Private   bool   `json:"private"`
	// Virtual marks an address a virtual machine, a container or a VPN owns:
	// a phone on the same Wi-Fi cannot reach this machine through it.
	Virtual bool `json:"virtual"`
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
	// Relay is the outbound tunnel for phones that cannot reach a LAN or a
	// VPN address; RelayOn is the switch, which survives a failed dial.
	Relay   remoteChannel `json:"relay"`
	RelayOn bool          `json:"relayOn"`
	// TokenExpire and TokenRotateAt are the rotation switch and how long the
	// token on screen has left; 0 means it never expires.
	TokenExpire   bool  `json:"tokenExpire"`
	TokenRotateAt int64 `json:"tokenRotateAt"`
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

	feishuSeen     map[string]bool // protected by mu; Feishu retries use message_id
	feishuOrder    []string
	feishuSessions map[string]string // UI-owned: one built-in conversation per source chat

	// tokenExpire is the rotation switch and tokenIssued when the current
	// token was made, unix milliseconds; prevToken and prevReplaced are the
	// token it replaced and when, so its grace window counts from the
	// replacement rather than from the issuance it inherited. tokenStop ends
	// the rotation timer.
	tokenExpire  bool
	tokenIssued  int64
	prevToken    string
	prevReplaced int64
	tokenStop    func() bool
	// clock is the app's clock, so a test can move the token's lifetime; a
	// host built without one reads the system's time.
	clock func() time.Time

	relayOn    bool
	relayURL   string
	relayEnv   string
	relayKey   string
	relayCert  tls.Certificate
	relayReady bool
	relayErr   string
	relayStop  chan struct{}
	relaySrv   *http.Server
	relayWS    *websocket.Conn

	publicURL string
}

// newRemoteHost builds the state from the config.
func newRemoteHost(a *app) *remoteHost {
	port := a.cfg.RemotePort
	if port == 0 {
		port = defaultRemotePort
	}
	relayURL := normalizeRelayURL(a.cfg.RemoteRelayURL)
	if relayURL == "" {
		relayURL = normalizeRelayURL(defaultRelayURL)
		if relayURL != "" {
			a.cfg.RemoteRelayURL = relayURL
		}
	}
	return &remoteHost{
		app: a,
		state: core.NewSignalFunc(a.cx, remoteView{
			Enabled: a.cfg.RemoteEnabled, Port: port, Token: a.cfg.RemoteToken,
			RelayOn: a.cfg.RemoteRelay,
			Relay:   remoteChannel{Installed: relayURL != "", Address: relayURL},
		}, nil),
		port: port, token: a.cfg.RemoteToken,
		search: &searchCache{entries: map[string]searchEntry{}},
		// A config written before the switch existed has no rotation, and
		// the issue time keeps a restart from restarting the clock.
		tokenExpire: a.cfg.RemoteTokenExpire, tokenIssued: a.cfg.RemoteTokenIssued,
		clock:   a.cx.Now,
		relayOn: a.cfg.RemoteRelay, relayURL: relayURL,
		relayEnv: a.cfg.RemoteRelayEnv, relayKey: a.cfg.RemoteRelayKey,
		publicURL: normalizePublicURL(a.cfg.RemotePublicURL),
	}
}

// init starts the configured server and scans the networks.
func (h *remoteHost) init() {
	h.app.cx.Cleanup(h.close)
	if h.app.cfg.RemoteEnabled {
		h.ensureToken()
		h.start()
		h.refresh()
		if h.app.cfg.RemoteRelay && h.relayURL != "" && h.ensureRelayIdentity() {
			h.startRelay()
		}
	}
	h.armTokenRotation()
}

// ensureToken generates the first token and persists it.
func (h *remoteHost) ensureToken() string {
	h.mu.Lock()
	token := h.token
	h.mu.Unlock()
	if token != "" {
		return token
	}
	return h.issueToken()
}

// issueToken makes a token, stores it and publishes it: a new token starts
// its rotation interval here, and the one it replaces keeps working for the
// grace window so a connected client can read the new one.
func (h *remoteHost) issueToken() string {
	token := randomToken()
	cmd := h.now().UnixMilli()
	h.mu.Lock()
	h.prevToken, h.prevReplaced = h.token, cmd
	h.token, h.tokenIssued = token, cmd
	h.mu.Unlock()
	h.app.cfg.RemoteToken = token
	h.app.cfg.RemoteTokenIssued = cmd
	h.app.st.edit(func(c *config) { c.RemoteToken = token; c.RemoteTokenIssued = cmd })
	h.publish()
	h.armTokenRotation()
	return token
}

// setEnabled starts or stops the server. Turning it off also ends the
// relay, because both are ways to reach the same API.
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
		if h.relayEnabled() {
			h.stopRelay()
			h.app.cfg.RemoteRelay = false
			h.app.st.edit(func(c *config) { c.RemoteRelay = false })
			h.mu.Lock()
			h.relayOn = false
			h.mu.Unlock()
		}
	}
	h.state.Update(func(v remoteView) remoteView { v.Enabled = on; return v })
	h.publish()
}

// relayEnabled reports the switch, not whether the tunnel is up.
func (h *remoteHost) relayEnabled() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.relayOn
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

// rotateToken replaces the token by hand, so phones with the old one lose
// access at once: a hand rotation is a decision, not a schedule, and there is
// no grace window it was promised.
func (h *remoteHost) rotateToken() {
	h.mu.Lock()
	h.token, h.tokenIssued = randomToken(), h.now().UnixMilli()
	h.prevToken, h.prevReplaced = "", 0
	token, issued := h.token, h.tokenIssued
	h.mu.Unlock()
	h.app.cfg.RemoteToken = token
	h.app.cfg.RemoteTokenIssued = issued
	h.app.st.edit(func(c *config) { c.RemoteToken = token; c.RemoteTokenIssued = issued })
	h.publish()
	h.armTokenRotation()
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
	h.stopRelay()
	h.stopTokenRotation()
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
	relayOn, relayURL, relayReady, relayErr := h.relayOn, h.relayURL, h.relayReady, h.relayErr
	expire, rotateAt := h.tokenExpire, h.rotateAtLocked()
	h.mu.Unlock()
	h.state.Update(func(v remoteView) remoteView {
		v.Running, v.Port, v.Token, v.Error = running, port, token, errText
		v.RelayOn = relayOn
		v.TokenExpire, v.TokenRotateAt = expire, rotateAt
		v.Relay = remoteChannel{Installed: relayURL != "", Ready: relayReady, Address: relayURL, Error: relayErr}
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
