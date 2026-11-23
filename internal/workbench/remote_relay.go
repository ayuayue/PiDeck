//go:build !js && !android && !ios

package workbench

// The outbound relay connector. A desktop that cannot be reached from the
// internet, or whose user does not want a VPN on the phone, dials out to
// a relay instead; the phone reaches the same HTTP API through that
// tunnel. The relay only copies bytes: the desktop's own TLS sits inside
// it, and the phone pins the certificate the pairing link names.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	_ "embed"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"example.com/pideck-v2/internal/relaywire"
	"golang.org/x/net/websocket"
)

// relayDefaultFile is the one line a release edits to point every install
// at its relay. Comments and blank lines are ignored, so a source build
// ships no address and the settings page asks for one.
//
//go:embed relay_default.txt
var relayDefaultFile string

// defaultRelayURL is the relay a release points at; -ldflags -X can still
// override it.
var defaultRelayURL = relayDefault()

func relayDefault() string {
	for _, line := range strings.Split(relayDefaultFile, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			return line
		}
	}
	return ""
}

// relayCertFile holds the desktop's self-signed certificate and its key.
const relayCertFile = "relay-cert.pem"

// relayCertificate loads the desktop's certificate, making one on first
// use. The phone pins its fingerprint, so it outlives address changes.
func relayCertificate(dir string) (tls.Certificate, error) {
	path := filepath.Join(dir, relayCertFile)
	if data, err := os.ReadFile(path); err == nil {
		if cert, err := tls.X509KeyPair(data, data); err == nil {
			return cert, nil
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "PiDeck V2 relay"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"pideck-relay"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return tls.Certificate{}, err
	}
	if err := writeFileAtomic(path, append(certPEM, keyPEM...), 0o600); err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(certPEM, keyPEM)
}

// relayFingerprint is what the pairing link pins: the SHA-256 of the
// certificate, in a form a QR code can hold.
func relayFingerprint(cert tls.Certificate) string {
	if len(cert.Certificate) == 0 {
		return ""
	}
	sum := sha256.Sum256(cert.Certificate[0])
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// normalizeRelayURL accepts what a user pastes and returns the tunnel
// address the desktop dials.
func normalizeRelayURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if !strings.Contains(raw, "://") {
		raw = "wss://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "ws", "wss":
	default:
		return ""
	}
	if !strings.HasSuffix(u.Path, relaywire.Path) {
		u.Path = strings.TrimSuffix(u.Path, "/") + relaywire.Path
	}
	return u.String()
}

// ensureRelayIdentity makes the environment, key and certificate the
// pairing link needs, once.
func (h *remoteHost) ensureRelayIdentity() bool {
	h.mu.Lock()
	env, key, cert := h.relayEnv, h.relayKey, h.relayCert
	h.mu.Unlock()
	if env != "" && key != "" && len(cert.Certificate) > 0 {
		return true
	}
	loaded, err := relayCertificate(h.app.dataDir)
	if err != nil {
		h.setRelayError("生成中继证书失败：" + err.Error())
		return false
	}
	if env == "" || key == "" {
		env, key = randomToken(), randomToken()
		h.app.cfg.RemoteRelayEnv, h.app.cfg.RemoteRelayKey = env, key
		h.app.st.edit(func(c *config) { c.RemoteRelayEnv = env; c.RemoteRelayKey = key })
	}
	h.mu.Lock()
	h.relayEnv, h.relayKey, h.relayCert = env, key, loaded
	h.mu.Unlock()
	return true
}

// setRelayURL stores the relay address and restarts a running tunnel.
func (h *remoteHost) setRelayURL(raw string) {
	url := normalizeRelayURL(raw)
	h.mu.Lock()
	same := url == h.relayURL
	was := h.relayOn
	h.mu.Unlock()
	h.app.cfg.RemoteRelayURL = url
	h.app.st.edit(func(c *config) { c.RemoteRelayURL = url })
	if same {
		h.publish()
		return
	}
	h.mu.Lock()
	h.relayURL = url
	h.mu.Unlock()
	if url == "" {
		// An empty address cannot carry a tunnel, so the switch follows.
		if was {
			h.stopRelay()
			h.app.cfg.RemoteRelay = false
			h.app.st.edit(func(c *config) { c.RemoteRelay = false })
			h.mu.Lock()
			h.relayOn = false
			h.mu.Unlock()
		}
	} else if was {
		h.startRelay()
	}
	h.publish()
}

// setRelayEnabled starts or stops the outbound tunnel.
func (h *remoteHost) setRelayEnabled(on bool) {
	if on {
		// The field is a draft until applied; turning the switch on is
		// also a decision to use what it holds.
		h.setRelayURL(h.app.cfg.RemoteRelayURL)
		h.mu.Lock()
		url := h.relayURL
		h.mu.Unlock()
		if url == "" {
			return
		}
		// The tunnel forwards to the local server, so it must listen.
		if !h.app.cfg.RemoteEnabled {
			h.setEnabled(true)
		}
		if !h.ensureRelayIdentity() {
			return
		}
	}
	h.app.cfg.RemoteRelay = on
	h.app.st.edit(func(c *config) { c.RemoteRelay = on })
	h.mu.Lock()
	h.relayOn = on
	h.mu.Unlock()
	if on {
		h.startRelay()
	} else {
		h.stopRelay()
	}
	h.publish()
}

// startRelay replaces any running loop with a fresh one.
func (h *remoteHost) startRelay() {
	h.stopRelay()
	stop := make(chan struct{})
	h.mu.Lock()
	h.relayStop = stop
	h.mu.Unlock()
	go h.relayLoop(stop)
}

// stopRelay ends the loop and the tunnel it holds.
func (h *remoteHost) stopRelay() {
	h.mu.Lock()
	stop, srv, ws := h.relayStop, h.relaySrv, h.relayWS
	h.relayStop, h.relaySrv, h.relayWS = nil, nil, nil
	h.relayReady = false
	h.mu.Unlock()
	if stop != nil {
		close(stop)
	}
	if srv != nil {
		_ = srv.Close()
	}
	if ws != nil {
		_ = ws.Close()
	}
}

// relayLoop redials with a capped backoff; a tunnel that stayed up a while
// starts again from the short delay.
func (h *remoteHost) relayLoop(stop chan struct{}) {
	backoff := time.Second
	for {
		select {
		case <-stop:
			return
		default:
		}
		started := time.Now()
		err := h.relayOnce(stop)
		select {
		case <-stop:
			return
		default:
		}
		if err != nil {
			h.setRelayError(err.Error())
		}
		if time.Since(started) > 30*time.Second {
			backoff = time.Second
		}
		select {
		case <-stop:
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > time.Minute {
			backoff = time.Minute
		}
	}
}

// relaySocket is the tunnel's WebSocket with its writes serialized: the
// TLS layer and the keepalive both write, and a WebSocket's frame writer
// interleaves two goroutines into a stream the far end cannot read.
type relaySocket struct {
	*websocket.Conn
	mu sync.Mutex
}

func (s *relaySocket) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Conn.Write(p)
}

// relayOnce opens one tunnel and serves HTTP over it until it closes.
func (h *remoteHost) relayOnce(stop chan struct{}) error {
	h.mu.Lock()
	relayURL, env, key, cert, token := h.relayURL, h.relayEnv, h.relayKey, h.relayCert, h.token
	h.mu.Unlock()
	if relayURL == "" || env == "" || key == "" || len(cert.Certificate) == 0 {
		return errors.New("中继还没有配置好")
	}
	link := relaywire.Link{
		Relay: relayURL, Env: env, Key: key,
		Fingerprint: relayFingerprint(cert), Token: token,
	}
	origin, _ := url.Parse("http://pideck-relay.local")
	cfg, err := websocket.NewConfig(link.URL(relaywire.RoleDesktop), origin.String())
	if err != nil {
		return err
	}
	cfg.Dialer = &net.Dialer{Timeout: 15 * time.Second}
	ws, err := websocket.DialConfig(cfg)
	if err != nil {
		return errors.New("连不上中继：" + relaywire.DialError(err))
	}
	// The TLS stream is binary; a text frame would be re-encoded by a
	// proxy that validates UTF-8.
	ws.PayloadType = websocket.BinaryFrame
	h.mu.Lock()
	h.relayWS = ws
	h.relayReady = true
	h.relayErr = ""
	h.mu.Unlock()
	h.publishAsync()

	// An empty frame keeps the edge from closing an idle tunnel; the TLS
	// stream above it skips empty frames. The frame writer is not safe for
	// two goroutines, so the keepalive and the TLS layer share one lock.
	sock := &relaySocket{Conn: ws}
	keepDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if _, err := sock.Write(nil); err != nil {
					return
				}
			case <-keepDone:
				return
			}
		}
	}()
	defer close(keepDone)

	tunnel := tls.Server(sock, &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
	})
	closed := make(chan struct{})
	conn := &relayConn{Conn: tunnel, closed: closed}
	ln := newRelayListener()
	srv := &http.Server{
		Handler:           h.handler(),
		ReadHeaderTimeout: 20 * time.Second,
		IdleTimeout:       3 * time.Minute,
	}
	h.mu.Lock()
	h.relaySrv = srv
	h.mu.Unlock()
	go func() { _ = srv.Serve(ln) }()
	ln.push(conn)

	select {
	case <-closed:
	case <-stop:
	}
	_ = srv.Close()
	ln.Close()
	_ = ws.Close()
	h.mu.Lock()
	h.relaySrv, h.relayWS, h.relayReady = nil, nil, false
	h.mu.Unlock()
	h.publishAsync()
	return nil
}

// setRelayError records why the tunnel is not up.
func (h *remoteHost) setRelayError(text string) {
	h.mu.Lock()
	h.relayErr, h.relayReady = text, false
	h.mu.Unlock()
	h.publishAsync()
}

// publishAsync is publish from the connector's goroutine; signals are
// written on the graph's own goroutine.
func (h *remoteHost) publishAsync() {
	if h.app == nil || h.app.cx == nil {
		return
	}
	h.app.cx.Post(h.publish)
}

// probeRelay dials a relay as a throwaway desktop and closes it. It proves
// the address speaks the protocol before the user turns the switch on, and
// it never touches this desktop's environment.
func (h *remoteHost) probeRelay(raw string) error {
	target := normalizeRelayURL(raw)
	if target == "" {
		return errors.New("中继地址格式不对")
	}
	link := relaywire.Link{
		Relay: target, Env: randomToken(), Key: randomToken(),
		Fingerprint: strings.Repeat("f", 43), Token: "probe",
	}
	origin, _ := url.Parse("http://pideck-relay.local")
	cfg, err := websocket.NewConfig(link.URL(relaywire.RoleDesktop), origin.String())
	if err != nil {
		return err
	}
	cfg.Dialer = &net.Dialer{Timeout: 10 * time.Second}
	ws, err := websocket.DialConfig(cfg)
	if err != nil {
		return errors.New("连不上中继：" + relaywire.DialError(err))
	}
	// The TLS stream is binary; a text frame would be re-encoded by a
	// proxy that validates UTF-8.
	ws.PayloadType = websocket.BinaryFrame
	_ = ws.Close()
	return nil
}

// relayLink is the pairing link the phone scans, or "" until the tunnel
// has an address and a token.
func (h *remoteHost) relayLink() string {
	h.mu.Lock()
	relayURL, env, key, cert, token := h.relayURL, h.relayEnv, h.relayKey, h.relayCert, h.token
	h.mu.Unlock()
	if relayURL == "" || env == "" || key == "" || token == "" || len(cert.Certificate) == 0 {
		return ""
	}
	return relaywire.Link{
		Relay: relayURL, Env: env, Key: key,
		Fingerprint: relayFingerprint(cert), Token: token,
	}.String()
}

// relayConn reports its close so the loop can dial again.
type relayConn struct {
	net.Conn
	once   sync.Once
	closed chan struct{}
}

func (c *relayConn) Close() error {
	c.once.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

// relayListener hands one tunnel connection to http.Server.
type relayListener struct {
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func newRelayListener() *relayListener {
	return &relayListener{conns: make(chan net.Conn, 1), done: make(chan struct{})}
}

func (l *relayListener) push(conn net.Conn) { l.conns <- conn }

func (l *relayListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.conns:
		return conn, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *relayListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *relayListener) Addr() net.Addr { return relayAddr{} }

type relayAddr struct{}

func (relayAddr) Network() string { return "relay" }
func (relayAddr) String() string  { return "relay" }
