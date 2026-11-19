//go:build !js && !android && !ios

package relay

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"example.com/pideck-lite/internal/relaywire"
	"golang.org/x/net/websocket"
)

func testLink(t *testing.T, base string) relaywire.Link {
	t.Helper()
	return relaywire.Link{
		Relay:       "ws" + strings.TrimPrefix(base, "http") + relaywire.Path,
		Env:         "env-0123456789",
		Key:         strings.Repeat("k", 32),
		Fingerprint: strings.Repeat("f", 43),
		Token:       "token",
	}
}

// TestTunnelPairsBothEnds checks that a desktop and a phone reach each
// other through one environment.
func TestTunnelPairsBothEnds(t *testing.T) {
	srv := New(Config{Keepalive: time.Second, IdleDesktop: 5 * time.Second})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	defer srv.Close()
	link := testLink(t, ts.URL)

	desktop, err := websocket.Dial(link.URL(relaywire.RoleDesktop), "", "http://localhost")
	if err != nil {
		t.Fatalf("desktop dial: %v", err)
	}
	defer desktop.Close()
	desktop.SetDeadline(time.Now().Add(3 * time.Second))

	phone, err := websocket.Dial(link.URL(relaywire.RolePhone), "", "http://localhost")
	if err != nil {
		t.Fatalf("phone dial: %v", err)
	}
	defer phone.Close()
	phone.SetDeadline(time.Now().Add(3 * time.Second))

	if _, err := phone.Write([]byte("from-phone")); err != nil {
		t.Fatalf("phone write: %v", err)
	}
	buf := make([]byte, len("from-phone"))
	if _, err := io.ReadFull(desktop, buf); err != nil {
		t.Fatalf("desktop read: %v", err)
	}
	if string(buf) != "from-phone" {
		t.Fatalf("desktop read %q", buf)
	}

	if _, err := desktop.Write([]byte("from-desktop")); err != nil {
		t.Fatalf("desktop write: %v", err)
	}
	buf = make([]byte, len("from-desktop"))
	if _, err := io.ReadFull(phone, buf); err != nil {
		t.Fatalf("phone read: %v", err)
	}
	if string(buf) != "from-desktop" {
		t.Fatalf("phone read %q", buf)
	}
}

// TestTunnelRefusals checks the pre-upgrade answers a wrong key and a
// missing desktop get.
func TestTunnelRefusals(t *testing.T) {
	srv := New(Config{Keepalive: time.Second, IdleDesktop: 5 * time.Second})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	defer srv.Close()
	link := testLink(t, ts.URL)

	status := func(u string) int {
		t.Helper()
		resp, err := http.Get(u)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	httpURL := func(l relaywire.Link, role string) string {
		return "http" + strings.TrimPrefix(l.URL(role), "ws")
	}

	if got := status(httpURL(link, relaywire.RolePhone)); got != http.StatusConflict {
		t.Fatalf("phone with no desktop = %d, want 409", got)
	}

	desktop, err := websocket.Dial(link.URL(relaywire.RoleDesktop), "", "http://localhost")
	if err != nil {
		t.Fatalf("desktop dial: %v", err)
	}
	defer desktop.Close()
	desktop.SetDeadline(time.Now().Add(3 * time.Second))

	wrong := link
	wrong.Key = strings.Repeat("j", 32)
	if got := status(httpURL(wrong, relaywire.RoleDesktop)); got != http.StatusUnauthorized {
		t.Fatalf("wrong key = %d, want 401", got)
	}
	if got := status(httpURL(wrong, relaywire.RolePhone)); got != http.StatusUnauthorized {
		t.Fatalf("wrong key = %d, want 401", got)
	}
}

// TestTunnelReplacesStaleEnds reconnects each end while the old socket is
// still open, as a phone that changed networks does: the new socket takes
// the slot instead of waiting for the old one to time out.
func TestTunnelReplacesStaleEnds(t *testing.T) {
	srv := New(Config{Keepalive: time.Second, IdleDesktop: 5 * time.Second})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	defer srv.Close()
	link := testLink(t, ts.URL)

	first, err := websocket.Dial(link.URL(relaywire.RoleDesktop), "", "http://localhost")
	if err != nil {
		t.Fatalf("first desktop dial: %v", err)
	}
	defer first.Close()

	second, err := websocket.Dial(link.URL(relaywire.RoleDesktop), "", "http://localhost")
	if err != nil {
		t.Fatalf("a desktop that redialed was refused: %v", err)
	}
	defer second.Close()
	second.SetDeadline(time.Now().Add(5 * time.Second))

	phone, err := websocket.Dial(link.URL(relaywire.RolePhone), "", "http://localhost")
	if err != nil {
		t.Fatalf("phone dial after the desktop redialed: %v", err)
	}
	defer phone.Close()

	next, err := websocket.Dial(link.URL(relaywire.RolePhone), "", "http://localhost")
	if err != nil {
		t.Fatalf("a phone that reconnected was refused: %v", err)
	}
	defer next.Close()
	next.SetDeadline(time.Now().Add(5 * time.Second))

	if _, err := next.Write([]byte("after-reconnect")); err != nil {
		t.Fatalf("phone write: %v", err)
	}
	buf := make([]byte, len("after-reconnect"))
	if _, err := io.ReadFull(second, buf); err != nil {
		t.Fatalf("desktop read: %v", err)
	}
	if string(buf) != "after-reconnect" {
		t.Fatalf("desktop read %q", buf)
	}
}

// TestTunnelReleasesAfterPhone checks that one phone leaving frees the
// environment for the next one.
func TestTunnelReleasesAfterPhone(t *testing.T) {
	srv := New(Config{Keepalive: time.Second, IdleDesktop: 5 * time.Second})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	defer srv.Close()
	link := testLink(t, ts.URL)

	desktop, err := websocket.Dial(link.URL(relaywire.RoleDesktop), "", "http://localhost")
	if err != nil {
		t.Fatalf("desktop dial: %v", err)
	}
	desktop.SetDeadline(time.Now().Add(3 * time.Second))

	phone, err := websocket.Dial(link.URL(relaywire.RolePhone), "", "http://localhost")
	if err != nil {
		t.Fatalf("phone dial: %v", err)
	}
	phone.Close()
	_ = desktop.Close()

	deadline := time.Now().Add(2 * time.Second)
	for {
		next, err := websocket.Dial(link.URL(relaywire.RoleDesktop), "", "http://localhost")
		if err == nil {
			next.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("desktop slot stayed busy: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestExternalRelay runs the same pairing against a relay that is already
// up, such as `npx wrangler dev` for infra/relay-worker. Set
// PIDECK_RELAY_TEST_URL to its tunnel address, e.g.
// ws://127.0.0.1:8787/v1/tunnel.
func TestExternalRelay(t *testing.T) {
	base := strings.TrimSpace(os.Getenv("PIDECK_RELAY_TEST_URL"))
	if base == "" {
		t.Skip("PIDECK_RELAY_TEST_URL is not set")
	}
	link := relaywire.Link{
		Relay:       base,
		Env:         fmt.Sprintf("env-%d", time.Now().UnixNano()),
		Key:         strings.Repeat("k", 32),
		Fingerprint: strings.Repeat("f", 43),
		Token:       "token",
	}

	if _, err := websocket.Dial(link.URL(relaywire.RolePhone), "", "http://localhost"); err == nil {
		t.Fatal("phone connected with no desktop")
	}

	desktop, err := websocket.Dial(link.URL(relaywire.RoleDesktop), "", "http://localhost")
	if err != nil {
		t.Fatalf("desktop dial: %v", err)
	}
	defer desktop.Close()
	desktop.SetDeadline(time.Now().Add(10 * time.Second))

	phone, err := websocket.Dial(link.URL(relaywire.RolePhone), "", "http://localhost")
	if err != nil {
		t.Fatalf("phone dial: %v", err)
	}
	defer phone.Close()
	phone.SetDeadline(time.Now().Add(10 * time.Second))

	if _, err := phone.Write([]byte("through-the-edge")); err != nil {
		t.Fatalf("phone write: %v", err)
	}
	buf := make([]byte, len("through-the-edge"))
	if _, err := io.ReadFull(desktop, buf); err != nil {
		t.Fatalf("desktop read: %v", err)
	}
	if string(buf) != "through-the-edge" {
		t.Fatalf("desktop read %q", buf)
	}
}

// TestExternalRelayReplacesStaleEnds reconnects each end while the old
// socket is still open, as a phone that changed networks does. The relay
// must take the new one instead of holding the slot for the old.
func TestExternalRelayReplacesStaleEnds(t *testing.T) {
	base := strings.TrimSpace(os.Getenv("PIDECK_RELAY_TEST_URL"))
	if base == "" {
		t.Skip("PIDECK_RELAY_TEST_URL is not set")
	}
	link := relaywire.Link{
		Relay:       base,
		Env:         fmt.Sprintf("env-%d", time.Now().UnixNano()),
		Key:         strings.Repeat("k", 32),
		Fingerprint: strings.Repeat("f", 43),
		Token:       "token",
	}

	first, err := websocket.Dial(link.URL(relaywire.RoleDesktop), "", "http://localhost")
	if err != nil {
		t.Fatalf("first desktop dial: %v", err)
	}
	defer first.Close()

	second, err := websocket.Dial(link.URL(relaywire.RoleDesktop), "", "http://localhost")
	if err != nil {
		t.Fatalf("a desktop that redialed was refused: %v", err)
	}
	defer second.Close()
	second.SetDeadline(time.Now().Add(10 * time.Second))

	phone, err := websocket.Dial(link.URL(relaywire.RolePhone), "", "http://localhost")
	if err != nil {
		t.Fatalf("phone dial after the desktop redialed: %v", err)
	}
	defer phone.Close()
	phone.SetDeadline(time.Now().Add(10 * time.Second))

	// A phone that reconnects takes the slot back at once.
	phone2, err := websocket.Dial(link.URL(relaywire.RolePhone), "", "http://localhost")
	if err != nil {
		t.Fatalf("a phone that reconnected was refused: %v", err)
	}
	defer phone2.Close()
	phone2.SetDeadline(time.Now().Add(10 * time.Second))

	if _, err := phone2.Write([]byte("after-reconnect")); err != nil {
		t.Fatalf("phone write: %v", err)
	}
	buf := make([]byte, len("after-reconnect"))
	if _, err := io.ReadFull(second, buf); err != nil {
		t.Fatalf("desktop read: %v", err)
	}
	if string(buf) != "after-reconnect" {
		t.Fatalf("desktop read %q", buf)
	}
}
