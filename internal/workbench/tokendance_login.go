//go:build !js && !android && !ios

package workbench

// TokenDance's one-click authorization (PKCE S256): the browser confirms
// and hands a one-time code back to a loopback listener here, which is
// traded for an API key. Nothing long-lived is typed by the user, and the
// verifier never leaves this process.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
)

const (
	tokenDanceAuthPage     = "https://tokendance.space/auth"
	tokenDanceKeyName      = "PiDeck Lite"
	tokenDanceAuthWait     = 3 * time.Minute
	tokenDanceCallbackPath = "/callback"
)

// tokenDanceExchange is where a code becomes a key; a test points it at a
// stub.
var tokenDanceExchange = "https://tokendance.space/portal/api/v1/auth/keys"

// pkcePair makes a verifier and its S256 challenge, as the platform wants
// them: 43 base64url characters, and the SHA-256 of those.
func pkcePair() (verifier, challenge string, err error) {
	var raw [32]byte
	if _, err = rand.Read(raw[:]); err != nil {
		return "", "", err
	}
	verifier = base64.RawURLEncoding.EncodeToString(raw[:])
	sum := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(sum[:])
	return verifier, challenge, nil
}

// tokenDanceAuthURL is the page the browser opens. The attribution is on
// the app, not on the callback port.
func tokenDanceAuthURL(challenge, callbackURL string) string {
	url, err := url.Parse(tokenDanceAuthPage)
	if err != nil {
		return tokenDanceAuthPage
	}
	q := url.Query()
	if callbackURL != "" {
		q.Set("callback_url", callbackURL)
	}
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("app_url", tokenDanceAppURL)
	q.Set("key_name", tokenDanceKeyName)
	url.RawQuery = q.Encode()
	return url.String()
}

// exchangeAuthCode trades the one-time code for a key. The full key only
// ever appears in this one answer.
func exchangeAuthCode(code, verifier string) (string, error) {
	body, err := json.Marshal(map[string]string{
		"code":                  code,
		"code_verifier":         verifier,
		"code_challenge_method": "S256",
	})
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenDanceExchange, strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := appHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 403 is an expired, used, or mismatched code; the body is not ours
		// to show.
		return "", fmt.Errorf("%s HTTP %d", apptext.T("授权没有通过，重新登录一次："), resp.StatusCode)
	}
	var answer struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil || strings.TrimSpace(answer.Key) == "" {
		return "", errors.New(apptext.T("授权页面没有返回密钥，重新登录一次。"))
	}
	return strings.TrimSpace(answer.Key), nil
}

// pkceToken is a short random path segment for the loopback listener.
func pkceToken() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

// tokenDanceCallback listens on a random loopback port for the redirect
// that carries the code, then shuts down.
type tokenDanceCallback struct {
	server *http.Server
	// URL is what the authorization page should redirect to.
	URL   string
	codes chan string
	once  chan struct{}
	onceD bool
}

// listenTokenDanceCode starts the one-shot listener.
func listenTokenDanceCode() (*tokenDanceCallback, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	token, err := pkceToken()
	if err != nil {
		_ = listener.Close()
		return nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	path := tokenDanceCallbackPath + "/" + token
	cb := &tokenDanceCallback{
		URL:   fmt.Sprintf("http://127.0.0.1:%d%s", port, path),
		codes: make(chan string, 1),
		once:  make(chan struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		code := strings.TrimSpace(r.URL.Query().Get("code"))
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if code == "" {
			_, _ = io.WriteString(w, "<p>没有收到授权码，回到应用重试。</p>")
			return
		}
		_, _ = io.WriteString(w, "<p>授权完成，可以关闭这个页面回到 PiDeck Lite。</p>")
		select {
		case cb.codes <- code:
		default:
		}
	})
	cb.server = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = cb.server.Serve(listener) }()
	return cb, nil
}

// wait takes the code, or gives up after the timeout.
func (cb *tokenDanceCallback) wait(timeout time.Duration) (string, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case code := <-cb.codes:
		return code, nil
	case <-timer.C:
		return "", errors.New(apptext.T("等你确认等太久了，重新登录一次。"))
	case <-cb.once:
		return "", errors.New(apptext.T("登录已取消。"))
	}
}

// close stops the listener and releases anything waiting on it.
func (cb *tokenDanceCallback) close() {
	if cb == nil {
		return
	}
	if !cb.onceD {
		cb.onceD = true
		close(cb.once)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = cb.server.Shutdown(ctx)
}
