package client

// Checks a desktop that rotates its access token: the client takes the new
// one from a reply to a request it was making anyway, and keeps asking with
// it, so a rotation never shows the user a logged-out page.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"example.com/pideck/internal/remotewire"
)

// TestRemoteClientTakesRotatedToken has the server refuse the first token
// and hand the current one back in every reply, the way a desktop does
// inside the grace window after a rotation.
func TestRemoteClientTakesRotatedToken(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("Authorization"))
		mu.Unlock()
		w.Header().Set(remotewire.TokenHeader, "rotated")
		_ = json.NewEncoder(w).Encode(remotewire.Snapshot{Host: "desk"})
	}))
	defer server.Close()

	client, _, err := newRemoteClient(server.URL, "first")
	if err != nil {
		t.Fatal(err)
	}
	defer client.close()
	recorded := make(chan string, 1)
	client.onToken = func(token string) { recorded <- token }

	snap, err := client.state()
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if snap.Host != "desk" {
		t.Fatalf("snapshot = %+v", snap)
	}
	if got := client.currentToken(); got != "rotated" {
		t.Fatalf("client token = %q, want the rotated one", got)
	}
	select {
	case token := <-recorded:
		if token != "rotated" {
			t.Fatalf("onToken got %q", token)
		}
	default:
		t.Fatal("onToken was never told about the rotation")
	}

	// The next request already presents the new token.
	if _, err := client.state(); err != nil {
		t.Fatalf("second state: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 || seen[0] != "Bearer first" || seen[1] != "Bearer rotated" {
		t.Fatalf("authorization headers = %v", seen)
	}
}

// TestRemoteClientKeepsTokenWithoutHeader keeps a desktop that never rotates
// its token working: no header, no change, no callback.
func TestRemoteClientKeepsTokenWithoutHeader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(remotewire.Snapshot{Host: "desk"})
	}))
	defer server.Close()

	client, _, err := newRemoteClient(server.URL, "first")
	if err != nil {
		t.Fatal(err)
	}
	defer client.close()
	client.onToken = func(token string) { t.Errorf("onToken(%q) fired without a rotation", token) }
	if _, err := client.state(); err != nil {
		t.Fatalf("state: %v", err)
	}
	if got := client.currentToken(); got != "first" {
		t.Fatalf("client token = %q, want the entered one", got)
	}
}
