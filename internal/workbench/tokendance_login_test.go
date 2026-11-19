//go:build !js && !android && !ios

package workbench

// Checks the authorization's pure parts: the PKCE pair, the page address,
// the code exchange, and the loopback listener.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// TestPKCEPair checks the pair matches the platform's rules: a 43-character
// url-safe verifier and the base64url SHA-256 of it.
func TestPKCEPair(t *testing.T) {
	verifier, challenge, err := pkcePair()
	if err != nil {
		t.Fatal(err)
	}
	if len(verifier) != 43 {
		t.Fatalf("verifier length = %d", len(verifier))
	}
	if strings.ContainsAny(verifier+challenge, "+/=") {
		t.Fatalf("not url-safe: %q %q", verifier, challenge)
	}
	sum := sha256.Sum256([]byte(verifier))
	if want := base64.RawURLEncoding.EncodeToString(sum[:]); challenge != want {
		t.Fatalf("challenge = %q, want %q", challenge, want)
	}
	other, _, _ := pkcePair()
	if other == verifier {
		t.Fatal("two verifiers came out the same")
	}
}

// TestAuthPageURL checks the authorization page carries PKCE, the
// attribution, and the callback when there is one.
func TestAuthPageURL(t *testing.T) {
	raw := tokenDanceAuthURL("CHALLENGE", "http://127.0.0.1:1234/callback/abc")
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u.Host != "tokendance.space" || u.Path != "/auth" {
		t.Fatalf("url = %q", raw)
	}
	q := u.Query()
	if q.Get("code_challenge") != "CHALLENGE" || q.Get("code_challenge_method") != "S256" {
		t.Fatalf("pkce params = %v", q)
	}
	if q.Get("app_url") != tokenDanceAppURL || q.Get("key_name") == "" {
		t.Fatalf("attribution params = %v", q)
	}
	if q.Get("callback_url") != "http://127.0.0.1:1234/callback/abc" {
		t.Fatalf("callback = %q", q.Get("callback_url"))
	}
	// Without a listener the page hands out a one-time code instead.
	headless, _ := url.Parse(tokenDanceAuthURL("CHALLENGE", ""))
	if headless.Query().Get("callback_url") != "" {
		t.Fatalf("headless url has a callback: %q", headless)
	}
}

// TestExchangeAuthCode checks the request body and both answers.
func TestExchangeAuthCode(t *testing.T) {
	minted := "sk-" + "from-auth"
	var body map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["code"] == "good-code" {
			_, _ = w.Write([]byte(`{"key":` + jsonQuote(minted) + `}`))
			return
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"invalid_code"}`))
	}))
	defer srv.Close()
	old := tokenDanceExchange
	tokenDanceExchange = srv.URL
	defer func() { tokenDanceExchange = old }()

	key, err := exchangeAuthCode("good-code", "verifier-1")
	if err != nil {
		t.Fatal(err)
	}
	if key != minted {
		t.Fatalf("key = %q", key)
	}
	if body["code_verifier"] != "verifier-1" || body["code_challenge_method"] != "S256" {
		t.Fatalf("body = %v", body)
	}
	if _, err := exchangeAuthCode("used-code", "verifier-1"); err == nil {
		t.Fatal("a rejected code should be an error")
	}
}

// TestLoopbackCode checks the listener hands back the code once and that a
// cancel ends the wait.
func TestLoopbackCode(t *testing.T) {
	cb, err := listenTokenDanceCode()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cb.URL, "http://127.0.0.1:") {
		t.Fatalf("callback url = %q", cb.URL)
	}
	resp, err := http.Get(cb.URL + "?code=abc123")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	code, err := cb.wait(2 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if code != "abc123" {
		t.Fatalf("code = %q", code)
	}
	cb.close()

	// A wait nobody answers times out rather than hanging.
	cb2, err := listenTokenDanceCode()
	if err != nil {
		t.Fatal(err)
	}
	defer cb2.close()
	go func() {
		time.Sleep(50 * time.Millisecond)
		cb2.close()
	}()
	if _, err := cb2.wait(2 * time.Second); err == nil {
		t.Fatal("a cancelled wait should be an error")
	}
}
