//go:build !js && !android && !ios

package workbench

// Drives a real app's phone server through one rotation: the switch issues a
// new token when its interval ends, the token on screen and in the saved
// config follow, and the client that was talking to it is handed the new one
// in a reply instead of being logged out.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// startRotationApp runs the app on a clock the test moves, with the phone
// server on and a token already issued.
func startRotationApp(t *testing.T) (*app, *nsgotest.App) {
	t.Helper()
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	if built == nil || built.remote == nil {
		t.Fatal("the app did not build its remote host")
	}
	built.remote.mu.Lock()
	built.remote.token, built.remote.tokenExpire = "first", true
	built.remote.tokenIssued = screen.Clock.Now().UnixMilli()
	built.remote.mu.Unlock()
	built.remote.armTokenRotation()
	return built, screen
}

// TestRemoteTokenRotationIssuesOnTime checks the timer: when the interval
// ends the token is replaced, stored, and published to the settings page,
// and the one it replaced survives only inside its grace window.
func TestRemoteTokenRotationIssuesOnTime(t *testing.T) {
	built, screen := startRotationApp(t)
	first := built.remote.currentToken()
	if first != "first" {
		t.Fatalf("token = %q, want the fixture's", first)
	}

	// A second short of the interval nothing has changed.
	screen.FastForward(remoteTokenTTL - time.Second)
	screen.Settle()
	if got := built.remote.currentToken(); got != first {
		t.Fatalf("token rotated early: %q", got)
	}

	// At the interval the token is replaced, and so is what the page shows.
	screen.FastForward(2 * time.Second)
	screen.Settle()
	second := built.remote.currentToken()
	if second == first || second == "" {
		t.Fatalf("token after the interval = %q, want a new one", second)
	}
	if got := built.remote.state.GetUntracked().Token; got != second {
		t.Fatalf("the settings page shows %q, want %q", got, second)
	}
	if got := built.cfg.RemoteToken; got != second {
		t.Fatalf("the config holds %q, want %q", got, second)
	}
	if !built.remote.remoteTokenAccepted(second) {
		t.Fatal("the new token was refused")
	}
	// The replaced one still works, so a client that was asleep makes one
	// more request and takes the new token from its reply.
	if !built.remote.remoteTokenAccepted(first) {
		t.Fatal("the token it replaced was refused inside the grace window")
	}

	// Past the grace window the old link is dead.
	screen.FastForward(remoteTokenGrace + time.Second)
	screen.Settle()
	if built.remote.remoteTokenAccepted(first) {
		t.Fatal("the replaced token still works past its grace window")
	}
	if !built.remote.remoteTokenAccepted(built.remote.currentToken()) {
		t.Fatal("the current token was refused")
	}
}

// TestRemoteTokenRotationReachesTheClient checks the header end to end: a
// request made with the replaced token succeeds and carries the new one.
func TestRemoteTokenRotationReachesTheClient(t *testing.T) {
	built, screen := startRotationApp(t)
	first := built.remote.currentToken()
	handler := built.remote.handler()

	// The handler waits for the UI thread, so each request runs in its own
	// goroutine while this one pumps the app.
	call := func(token string) *httptest.ResponseRecorder {
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			done <- rec
		}()
		deadline := time.Now().Add(10 * time.Second)
		for {
			select {
			case rec := <-done:
				return rec
			default:
				if time.Now().After(deadline) {
					t.Fatal("request timed out")
				}
				screen.Settle()
				time.Sleep(2 * time.Millisecond)
			}
		}
	}

	if rec := call(first); rec.Code != http.StatusOK || rec.Header().Get(remotewire.TokenHeader) != "" {
		t.Fatalf("the current token: %d, header %q", rec.Code, rec.Header().Get(remotewire.TokenHeader))
	}

	screen.FastForward(remoteTokenTTL + time.Second)
	screen.Settle()
	second := built.remote.currentToken()
	rec := call(first)
	if rec.Code != http.StatusOK {
		t.Fatalf("the replaced token inside its grace window = %d: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get(remotewire.TokenHeader); got != second {
		t.Fatalf("reply carried %q, want the new token %q", got, second)
	}
	// The client presents it from then on, so its next request needs no
	// header at all.
	if rec := call(second); rec.Header().Get(remotewire.TokenHeader) != "" {
		t.Fatalf("the current token was still handed a new one")
	}

	// Past the grace window the replaced token is refused, and refused
	// requests hand out nothing.
	screen.FastForward(remoteTokenGrace + time.Second)
	screen.Settle()
	rec = call(first)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("the replaced token past its grace window = %d, want 401", rec.Code)
	}
	if got := rec.Header().Get(remotewire.TokenHeader); got != "" {
		t.Fatalf("a refused request was handed %q", got)
	}
	if !strings.Contains(rec.Body.String(), "令牌") {
		t.Fatalf("refusal says %q", rec.Body.String())
	}
}

// TestRemoteTokenManualRotationEndsTheOldOneAtOnce keeps the button's
// promise: a hand rotation is a decision, so the token it replaced is dead
// immediately rather than living out a grace window it was never promised.
func TestRemoteTokenManualRotationEndsTheOldOneAtOnce(t *testing.T) {
	built, screen := startRotationApp(t)
	first := built.remote.currentToken()
	built.remote.rotateToken()
	screen.Settle()
	second := built.remote.currentToken()
	if second == first || second == "" {
		t.Fatalf("token after a hand rotation = %q, want a new one", second)
	}
	if built.remote.remoteTokenAccepted(first) {
		t.Fatal("a hand rotation kept the replaced token working")
	}
	if !built.remote.remoteTokenAccepted(second) {
		t.Fatal("the new token was refused")
	}
}

// TestRemoteTokenRotationSwitchIssuesAToken checks turning the switch on: a
// token made before it existed has no start time, so opening the switch
// starts the clock with a fresh one rather than an unknown age.
func TestRemoteTokenRotationSwitchIssuesAToken(t *testing.T) {
	built, screen := startRotationApp(t)
	built.remote.setTokenExpire(false)
	screen.Settle()
	if got := built.remote.tokenRotateAt(); got != 0 {
		t.Fatalf("rotateAt = %d with rotation off, want 0", got)
	}
	before := built.remote.currentToken()

	built.remote.mu.Lock()
	built.remote.tokenIssued = 0
	built.remote.mu.Unlock()
	built.remote.setTokenExpire(true)
	screen.Settle()
	if got := built.remote.currentToken(); got == before || got == "" {
		t.Fatalf("token after turning the switch on = %q, want a fresh one", got)
	}
	if got := built.remote.tokenRotateAt(); got != screen.Clock.Now().Add(remoteTokenTTL).UnixMilli() {
		t.Fatalf("rotateAt = %d, want one interval from now", got)
	}
	if !built.cfg.RemoteTokenExpire {
		t.Fatal("the switch was not stored")
	}
}
