//go:build !js

package client

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/relaywire"
	"golang.org/x/net/websocket"
)

// testCertificate makes a desktop certificate and its fingerprint.
func testCertificate(t *testing.T) (tls.Certificate, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "PiDeck relay"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"pideck-relay"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	return cert, base64.RawURLEncoding.EncodeToString(sum[:])
}

// pipeRelay stands in for the relay service: it holds one desktop and one
// phone and copies bytes between them.
type pipeRelay struct {
	desktop chan *websocket.Conn
	phone   chan *websocket.Conn
	stop    chan struct{}
}

func newPipeRelay() *pipeRelay {
	return &pipeRelay{
		desktop: make(chan *websocket.Conn, 1),
		phone:   make(chan *websocket.Conn, 1),
		stop:    make(chan struct{}),
	}
}

func (r *pipeRelay) handler(ws *websocket.Conn) {
	if ws.Request().URL.Query().Get("role") == relaywire.RoleDesktop {
		r.desktop <- ws
	} else {
		r.phone <- ws
	}
	<-r.stop
}

func (r *pipeRelay) pair() {
	desktop := <-r.desktop
	phone := <-r.phone
	go func() { _, _ = io.Copy(desktop, phone) }()
	go func() { _, _ = io.Copy(phone, desktop) }()
}

func testRelay(t *testing.T) (*httptest.Server, *pipeRelay) {
	t.Helper()
	r := newPipeRelay()
	ts := httptest.NewServer(&websocket.Server{Handler: r.handler})
	go r.pair()
	t.Cleanup(func() {
		close(r.stop)
		ts.Close()
	})
	return ts, r
}

// serveDesktop answers one HTTP request over a tunnel, standing in for the
// desktop's own server.
func serveDesktop(t *testing.T, link relaywire.Link, cert tls.Certificate) {
	t.Helper()
	ws, err := websocket.Dial(link.URL(relaywire.RoleDesktop), "", "http://pideck-relay.local")
	if err != nil {
		t.Fatalf("desktop dial: %v", err)
	}
	ws.PayloadType = websocket.BinaryFrame
	go func() {
		defer ws.Close()
		tunnel := tls.Server(ws, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13})
		br := bufio.NewReader(tunnel)
		if _, err := readRequest(br); err != nil {
			return
		}
		_, _ = tunnel.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"))
	}()
}

func readRequest(br *bufio.Reader) (string, error) {
	line, err := br.ReadString('\n')
	if err != nil {
		return "", err
	}
	for {
		next, err := br.ReadString('\n')
		if err != nil {
			return line, err
		}
		if next == "\r\n" || next == "\n" {
			return line, nil
		}
	}
}

func testLink(server string, fingerprint string) relaywire.Link {
	return relaywire.Link{
		Relay:       "ws" + strings.TrimPrefix(server, "http") + relaywire.Path,
		Env:         "env-0123456789",
		Key:         strings.Repeat("k", 32),
		Fingerprint: fingerprint,
		Token:       "token",
	}
}

// TestDialRelayPinsCertificate checks that a matching fingerprint opens
// the tunnel and a different one does not.
func TestDialRelayPinsCertificate(t *testing.T) {
	ts, _ := testRelay(t)
	cert, fingerprint := testCertificate(t)
	link := testLink(ts.URL, fingerprint)
	serveDesktop(t, link, cert)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := dialRelay(ctx, link)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte("GET /api/ping HTTP/1.1\r\nHost: relay\r\n\r\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	reply := make([]byte, len("HTTP/1.1 200"))
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.HasPrefix(string(reply), "HTTP/1.1 200") {
		t.Fatalf("reply = %q", reply)
	}
}

func TestDialRelayRefusesAnotherCertificate(t *testing.T) {
	ts, _ := testRelay(t)
	cert, _ := testCertificate(t)
	_, other := testCertificate(t)
	link := testLink(ts.URL, other)
	serveDesktop(t, link, cert)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := dialRelay(ctx, link); err == nil {
		t.Fatal("tunnel accepted a certificate the link did not pin")
	} else if !strings.Contains(err.Error(), "不一致") {
		t.Fatalf("error = %v", err)
	}
}

// TestNewRelayClientKeepsTheLink checks that reconnecting keeps the
// pairing link rather than a display address.
func TestNewRelayClientKeepsTheLink(t *testing.T) {
	link := testLink("http://relay.example.com", strings.Repeat("c", 43))
	text := link.String()
	client, token, err := newRemoteClient(text, "")
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	if token != link.Token || client.token != link.Token {
		t.Fatalf("token = %q / %q", token, client.token)
	}
	if client.source != text {
		t.Fatalf("source = %q", client.source)
	}
	if !strings.HasPrefix(client.base, "http://relay.") {
		t.Fatalf("base = %q", client.base)
	}
}

// TestExternalRelayPhone runs the phone's real dialer (WebSocket, TLS and
// certificate pinning) through a deployed relay. Set PIDECK_RELAY_TEST_URL
// to its tunnel address to run it.
func TestExternalRelayPhone(t *testing.T) {
	base := strings.TrimSpace(os.Getenv("PIDECK_RELAY_TEST_URL"))
	if base == "" {
		t.Skip("PIDECK_RELAY_TEST_URL is not set")
	}
	cert, fingerprint := testCertificate(t)
	link := relaywire.Link{
		Relay:       base,
		Env:         fmt.Sprintf("env-%d", time.Now().UnixNano()),
		Key:         strings.Repeat("k", 32),
		Fingerprint: fingerprint,
		Token:       "token",
	}

	ws, err := websocket.Dial(link.URL(relaywire.RoleDesktop), "", "http://localhost")
	if err != nil {
		t.Fatalf("desktop dial: %v", err)
	}
	ws.PayloadType = websocket.BinaryFrame
	defer ws.Close()
	go func() {
		tunnel := tls.Server(ws, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13})
		if err := tunnel.Handshake(); err != nil {
			t.Logf("desktop handshake: %v", err)
			return
		}
		br := bufio.NewReader(tunnel)
		if _, err := readRequest(br); err != nil {
			t.Logf("desktop read: %v", err)
			return
		}
		_, _ = tunnel.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"))
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, err := dialRelay(ctx, link)
	if err != nil {
		t.Fatalf("phone dial: %v", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write([]byte("GET /api/ping HTTP/1.1\r\nHost: relay\r\n\r\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	reply := make([]byte, len("HTTP/1.1 200"))
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.HasPrefix(string(reply), "HTTP/1.1 200") {
		t.Fatalf("reply = %q", reply)
	}
}
