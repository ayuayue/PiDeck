//go:build !js && !android && !ios

package workbench

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/relaywire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"golang.org/x/net/websocket"
)

// tunnelRelay stands in for the relay service: one desktop, one phone.
type tunnelRelay struct {
	desktop chan *websocket.Conn
	phone   chan *websocket.Conn
	stop    chan struct{}
}

func newTunnelRelay() *tunnelRelay {
	return &tunnelRelay{
		desktop: make(chan *websocket.Conn, 1),
		phone:   make(chan *websocket.Conn, 1),
		stop:    make(chan struct{}),
	}
}

func (r *tunnelRelay) handler(ws *websocket.Conn) {
	if ws.Request().URL.Query().Get("role") == relaywire.RoleDesktop {
		r.desktop <- ws
	} else {
		r.phone <- ws
	}
	<-r.stop
}

func (r *tunnelRelay) pair() {
	desktop := <-r.desktop
	phone := <-r.phone
	go func() { _, _ = io.Copy(desktop, phone) }()
	go func() { _, _ = io.Copy(phone, desktop) }()
}

// TestRelayTunnelServesTheAPI checks the desktop's outbound connector: a
// phone reaches /api/ping through the tunnel and the desktop's own TLS.
func TestRelayTunnelServesTheAPI(t *testing.T) {
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var built *app
	root := func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}
	nsgotest.Start(t, root, nsgotest.Size(1320, 860))

	cert, err := relayCertificate(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	link := relaywire.Link{
		Env:         "env-0123456789",
		Key:         strings.Repeat("k", 32),
		Fingerprint: relayFingerprint(cert),
		Token:       "secret",
	}
	// A deployed relay, when one is named, exercises the real edge; the
	// fake one keeps the normal suite offline.
	if base := strings.TrimSpace(os.Getenv("PIDECK_RELAY_TEST_URL")); base != "" {
		link.Relay = base
	} else {
		relaySrv := newTunnelRelay()
		ts := httptest.NewServer(&websocket.Server{Handler: relaySrv.handler})
		defer ts.Close()
		go relaySrv.pair()
		defer close(relaySrv.stop)
		link.Relay = "ws" + strings.TrimPrefix(ts.URL, "http") + relaywire.Path
	}

	h := built.remote
	h.mu.Lock()
	h.token, h.relayURL, h.relayEnv, h.relayKey, h.relayCert = link.Token, link.Relay, link.Env, link.Key, cert
	h.mu.Unlock()

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		_ = h.relayOnce(stop)
		close(done)
	}()

	ws, err := websocket.Dial(link.URL(relaywire.RolePhone), "", "http://pideck-relay.local")
	if err != nil {
		t.Fatalf("phone dial: %v", err)
	}
	ws.PayloadType = websocket.BinaryFrame
	defer ws.Close()
	tunnel := tls.Client(ws, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
	defer tunnel.Close()
	tunnel.SetDeadline(time.Now().Add(5 * time.Second))

	req, _ := http.NewRequest(http.MethodGet, "http://relay/api/ping", nil)
	req.Header.Set("Authorization", "Bearer "+link.Token)
	if err := req.Write(tunnel); err != nil {
		t.Fatalf("write: %v", err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(tunnel), req)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var ping struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ping); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if ping.Name != "PiDeck V2" {
		t.Fatalf("ping = %+v", ping)
	}

	close(stop)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("relay connector did not stop")
	}
}

// TestProbeRelay checks the "test" button's dial: a relay that speaks the
// protocol passes, an address that is not a WebSocket fails.
func TestProbeRelay(t *testing.T) {
	stop := make(chan struct{})
	ts := httptest.NewServer(&websocket.Server{Handler: func(ws *websocket.Conn) { <-stop }})
	defer ts.Close()
	defer close(stop)

	h := &remoteHost{}
	relay := "ws" + strings.TrimPrefix(ts.URL, "http") + relaywire.Path
	if err := h.probeRelay(relay); err != nil {
		t.Fatalf("probe: %v", err)
	}
	if err := h.probeRelay("http://relay.example.com"); err == nil {
		t.Fatal("accepted an http address")
	}
	if err := h.probeRelay("ws://127.0.0.1:1/v1/tunnel"); err == nil {
		t.Fatal("accepted a dead address")
	}
}
