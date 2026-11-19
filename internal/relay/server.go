// Package relay is the small service a PiDeck Lite desktop dials out to so
// a phone can reach it without a VPN on either side. It pairs one desktop
// with one phone per environment and copies bytes between their WebSocket
// connections; everything above those bytes is the desktop's own TLS, so
// the relay never sees the token, the transcript or a prompt.
package relay

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"example.com/pideck-lite/internal/relaywire"
	"golang.org/x/net/websocket"
)

// Config bounds what one relay keeps in memory and how long an idle
// desktop holds a slot.
type Config struct {
	// MaxEnvs is the number of environments remembered at once.
	MaxEnvs int
	// IdleDesktop closes a desktop that no phone reached in this time.
	IdleDesktop time.Duration
	// Keepalive is the empty frame that keeps a proxy from closing an
	// idle WebSocket.
	Keepalive time.Duration
	// MaxFrame is the largest WebSocket message accepted.
	MaxFrame int64
	// Logger receives one line per connection. Nil discards them.
	Logger *log.Logger
}

// DefaultConfig is a relay for a small user base.
func DefaultConfig() Config {
	return Config{
		MaxEnvs:     5000,
		IdleDesktop: 10 * time.Minute,
		Keepalive:   30 * time.Second,
		MaxFrame:    1 << 20,
	}
}

// Server is the relay's HTTP handler and its environment table.
type Server struct {
	cfg Config

	mu   sync.Mutex
	envs map[string]*environment
}

type environment struct {
	key     [32]byte
	desktop *websocket.Conn
	phone   *websocket.Conn
	paired  chan struct{}
	done    chan struct{}
	// stop ends the desktop's wait when a newer desktop takes the slot.
	stop chan struct{}
	seen time.Time
}

// New builds a relay. A zero Config takes DefaultConfig.
func New(cfg Config) *Server {
	def := DefaultConfig()
	if cfg.MaxEnvs <= 0 {
		cfg.MaxEnvs = def.MaxEnvs
	}
	if cfg.IdleDesktop <= 0 {
		cfg.IdleDesktop = def.IdleDesktop
	}
	if cfg.Keepalive <= 0 {
		cfg.Keepalive = def.Keepalive
	}
	if cfg.MaxFrame <= 0 {
		cfg.MaxFrame = def.MaxFrame
	}
	return &Server{cfg: cfg, envs: map[string]*environment{}}
}

// Handler serves the tunnel and a health check.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(relaywire.Path, s.serveTunnel)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})
	return mux
}

// serveTunnel checks a request before the WebSocket upgrade, so a bad key
// or a busy environment gets a readable HTTP status instead of a silent
// close.
func (s *Server) serveTunnel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	envID, key, role := q.Get("env"), q.Get("key"), q.Get("role")
	if !validID(envID) || len(key) < 16 || len(key) > 128 {
		http.Error(w, "bad environment", http.StatusBadRequest)
		return
	}
	if role != relaywire.RoleDesktop && role != relaywire.RolePhone {
		http.Error(w, "bad role", http.StatusBadRequest)
		return
	}
	hash := sha256.Sum256([]byte(key))
	if err := s.check(envID, hash, role); err != nil {
		status := http.StatusConflict
		if errors.Is(err, errWrongKey) {
			status = http.StatusUnauthorized
		}
		http.Error(w, err.Error(), status)
		return
	}

	ws := &websocket.Server{
		// Go clients send no Origin header; the key above is the check.
		Handler: func(conn *websocket.Conn) {
			conn.MaxPayloadBytes = int(s.cfg.MaxFrame)
			conn.PayloadType = websocket.BinaryFrame
			s.attach(envID, hash, role, conn)
		},
	}
	ws.ServeHTTP(w, r)
}

var (
	errWrongKey = errors.New("wrong key")
	errBusy     = errors.New("environment busy")
	errNoHost   = errors.New("desktop offline")
)

// check is the pre-upgrade look at the table. attach repeats it after the
// upgrade because two requests can pass here together.
func (s *Server) check(envID string, hash [32]byte, role string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	env := s.envs[envID]
	switch role {
	case relaywire.RoleDesktop:
		if env == nil {
			if len(s.envs) >= s.cfg.MaxEnvs {
				return errBusy
			}
			return nil
		}
		if !sameKey(env.key, hash) {
			return errWrongKey
		}
	case relaywire.RolePhone:
		if env == nil || env.desktop == nil {
			return errNoHost
		}
		if !sameKey(env.key, hash) {
			return errWrongKey
		}
	}
	return nil
}

// attach registers one end and runs the tunnel until it closes.
func (s *Server) attach(envID string, hash [32]byte, role string, conn *websocket.Conn) {
	s.mu.Lock()
	env := s.envs[envID]
	if role == relaywire.RoleDesktop {
		if env != nil && !sameKey(env.key, hash) {
			s.mu.Unlock()
			_ = conn.Close()
			return
		}
		if env == nil {
			env = &environment{key: hash}
			s.envs[envID] = env
		}
		// A desktop that redialed takes its slot back at once: the socket
		// it left is one the network dropped without a close.
		old, oldStop := env.desktop, env.stop
		env.desktop = conn
		env.paired = make(chan struct{})
		env.done = nil
		env.stop = make(chan struct{})
		env.seen = time.Now()
		paired, stop := env.paired, env.stop
		s.mu.Unlock()
		if oldStop != nil {
			close(oldStop)
		}
		if old != nil {
			_ = old.Close()
		}
		s.serveDesktop(envID, env, conn, paired, stop)
		return
	}

	if env == nil || env.desktop == nil || !sameKey(env.key, hash) {
		s.mu.Unlock()
		_ = conn.Close()
		return
	}
	// A phone that changed networks reconnects the same way. Its pipe gets
	// a channel of its own, so the one it left ending does not end this.
	oldPhone := env.phone
	done := make(chan struct{})
	env.phone = conn
	env.done = done
	env.seen = time.Now()
	paired := env.paired
	desktop := env.desktop
	select {
	case <-paired:
		// A phone paired with this desktop before; its timer is off.
	default:
		close(paired)
	}
	s.mu.Unlock()
	if oldPhone != nil {
		_ = oldPhone.Close()
	}

	s.logf("pair env=%s", short(envID))
	s.pipe(desktop, conn, done)

	s.mu.Lock()
	if current := s.envs[envID]; current == env && env.phone == conn {
		env.phone, env.done = nil, nil
		env.seen = time.Now()
	}
	s.mu.Unlock()
	s.logf("unpair env=%s", short(envID))
}

// serveDesktop holds the desktop's slot open and keeps it alive until it
// is replaced, its socket fails, or no phone reaches it in time.
func (s *Server) serveDesktop(envID string, env *environment, conn *websocket.Conn, paired, stop chan struct{}) {
	keep := time.NewTicker(s.cfg.Keepalive)
	defer keep.Stop()
	idle := time.NewTimer(s.cfg.IdleDesktop)
	defer idle.Stop()

	for {
		select {
		case <-stop:
			// A newer desktop holds the slot.
			return
		case <-paired:
			// A phone reached it, so it may stay as long as it likes.
			idle.Stop()
		case <-keep.C:
			if _, err := conn.Write([]byte{}); err != nil {
				s.release(envID, env, conn)
				_ = conn.Close()
				return
			}
		case <-idle.C:
			s.logf("idle env=%s", short(envID))
			s.release(envID, env, conn)
			_ = conn.Close()
			return
		}
	}
}

// release clears the desktop's slot when it is still the one holding it.
func (s *Server) release(envID string, env *environment, conn *websocket.Conn) {
	s.mu.Lock()
	if current := s.envs[envID]; current == env && env.desktop == conn {
		env.desktop, env.paired, env.done, env.stop = nil, nil, nil, nil
		env.seen = time.Now()
	}
	s.mu.Unlock()
}

// pipe copies bytes both ways and closes both ends when either finishes.
func (s *Server) pipe(a, b *websocket.Conn, done chan struct{}) {
	stop := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(stop) }) }

	// The keepalive shares each socket with a copy; a WebSocket's frame
	// writer is not safe for two goroutines, so writes take turns.
	var muA, muB sync.Mutex
	go func() {
		keep := time.NewTicker(s.cfg.Keepalive)
		defer keep.Stop()
		for {
			select {
			case <-keep.C:
				_, _ = writeFrame(&muA, a, nil)
				_, _ = writeFrame(&muB, b, nil)
			case <-stop:
				return
			}
		}
	}()

	copied := make(chan struct{}, 2)
	go func() { _, _ = copyBytes(&muB, b, a); copied <- struct{}{} }()
	go func() { _, _ = copyBytes(&muA, a, b); copied <- struct{}{} }()
	<-copied
	finish()
	// Only the phone ends here: the desktop keeps its slot for the next
	// phone, and its own keepalive closes it when the desktop is gone.
	_ = b.Close()
	<-copied
	close(done)
}

// copyBytes is io.Copy with a bounded buffer, kept apart so the direction
// is obvious at each call.
func copyBytes(mu *sync.Mutex, dst, src *websocket.Conn) (int64, error) {
	buf := make([]byte, 32<<10)
	var total int64
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := writeFrame(mu, dst, buf[:n]); werr != nil {
				return total, werr
			}
			total += int64(n)
		}
		if err != nil {
			return total, err
		}
	}
}

// writeFrame writes one message while holding the socket's write lock.
func writeFrame(mu *sync.Mutex, conn *websocket.Conn, p []byte) (int, error) {
	mu.Lock()
	defer mu.Unlock()
	return conn.Write(p)
}

// Sweep drops environments that have been idle with neither end attached.
func (s *Server) Sweep(olderThan time.Duration) {
	cutoff := time.Now().Add(-olderThan)
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, env := range s.envs {
		if env.desktop == nil && env.phone == nil && env.seen.Before(cutoff) {
			delete(s.envs, id)
		}
	}
}

// Close ends every tunnel, for a shutdown.
func (s *Server) Close() {
	s.mu.Lock()
	envs := make([]*environment, 0, len(s.envs))
	for _, env := range s.envs {
		envs = append(envs, env)
	}
	s.envs = map[string]*environment{}
	s.mu.Unlock()
	for _, env := range envs {
		if env.desktop != nil {
			_ = env.desktop.Close()
		}
		if env.phone != nil {
			_ = env.phone.Close()
		}
	}
}

func (s *Server) logf(format string, args ...any) {
	if s.cfg.Logger != nil {
		s.cfg.Logger.Printf(format, args...)
	}
}

func sameKey(a, b [32]byte) bool {
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

func validID(id string) bool {
	if len(id) < 8 || len(id) > 128 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

func short(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}
