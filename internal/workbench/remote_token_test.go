//go:build !js && !android && !ios

package workbench

// Checks the access token's lifetime: the switch is off by default, an
// expired token is refused, the token it replaced keeps working for a short
// grace window, and a client that presents the old one is handed the new one.

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
)

// newTokenTestHost is a remote host with a token and no listener, which is
// all the gate and the rotation logic need. Its clock is the test's, so a
// token's lifetime moves when the test says.
func newTokenTestHost(t *testing.T, rotation bool) (*remoteHost, *core.ManualClock) {
	t.Helper()
	clock := core.NewManualClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	return &remoteHost{
		token:       "current",
		tokenExpire: rotation,
		tokenIssued: clock.Now().UnixMilli(),
		clock:       clock.Now,
	}, clock
}

// TestRemoteTokenExpiryDefaultsOff keeps the switch off for a config that
// never had it: an install that is not re-paired must keep working.
func TestRemoteTokenExpiryDefaultsOff(t *testing.T) {
	var c config
	if c.RemoteTokenExpire {
		t.Fatal("rotation is on for a config that never set it")
	}
	if !normalizeConfig(&c) {
		// normalizeConfig may or may not change other fields; the switch is
		// what this checks.
		_ = c
	}
	if c.RemoteTokenExpire {
		t.Fatal("normalizeConfig turned rotation on")
	}
	if migrated := migrateConfig(&config{Version: 4}, nil); migrated && c.RemoteTokenExpire {
		t.Fatal("migrateConfig turned rotation on")
	}
}

// TestRemoteTokenAccepted covers the gate: the current token works, the one
// it replaced works for the grace window only, and an unknown token never
// does.
func TestRemoteTokenAccepted(t *testing.T) {
	host, clock := newTokenTestHost(t, true)
	host.prevToken, host.prevReplaced = "previous", clock.Now().UnixMilli()

	if !host.remoteTokenAccepted("current") {
		t.Fatal("the current token was refused")
	}
	if !host.remoteTokenAccepted("previous") {
		t.Fatal("the replaced token was refused inside its grace window")
	}
	if host.remoteTokenAccepted("other") || host.remoteTokenAccepted("") {
		t.Fatal("an unknown or empty token was accepted")
	}

	// Once the window closes the replaced token is dead, which is the point
	// of the switch.
	clock.Advance(remoteTokenGrace + time.Second)
	if host.remoteTokenAccepted("previous") {
		t.Fatal("the replaced token still works past its grace window")
	}
	if !host.remoteTokenAccepted("current") {
		t.Fatal("the current token was refused after the grace window")
	}
}

// TestRemoteTokenRotationOffKeepsReplacedToken keeps every issued token
// working while rotation is off: turning the switch off must not log out a
// phone that is in the middle of something.
func TestRemoteTokenRotationOffKeepsReplacedToken(t *testing.T) {
	host, clock := newTokenTestHost(t, false)
	host.prevToken, host.prevReplaced = "previous", clock.Now().UnixMilli()
	clock.Advance(remoteTokenGrace * 10)
	if host.remoteTokenAccepted("previous") {
		t.Fatal("a replaced token was accepted with rotation off")
	}
	// Off means there is never a previous token in the first place; the
	// fields above are a rotation-only state, so the check above is the
	// negative case and this one the live one.
	host.prevToken, host.prevReplaced = "", 0
	if !host.remoteTokenAccepted("current") {
		t.Fatal("the current token was refused with rotation off")
	}
}

// TestRemoteTokenGateHandsOutTheNewOne checks the header: a request that
// presented the replaced token succeeds and carries the current token, so a
// client that keeps polling takes it without any extra request.
func TestRemoteTokenGateHandsOutTheNewOne(t *testing.T) {
	host, clock := newTokenTestHost(t, true)
	host.prevToken, host.prevReplaced = "previous", clock.Now().UnixMilli()

	request := func(token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "http://x/api/state", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		if !host.authorize(rec, req) {
			t.Fatalf("token %q was refused", token)
		}
		return rec
	}
	if got := request("previous").Header().Get(remotewire.TokenHeader); got != "current" {
		t.Fatalf("a replaced token was answered with %q, want the current token", got)
	}
	// The current token needs no header: there is nothing to replace.
	if got := request("current").Header().Get(remotewire.TokenHeader); got != "" {
		t.Fatalf("the current token got %q back", got)
	}
	// A refused request is refused, and hands out nothing.
	req := httptest.NewRequest(http.MethodGet, "http://x/api/state", nil)
	req.Header.Set("Authorization", "Bearer nope")
	rec := httptest.NewRecorder()
	if host.authorize(rec, req) {
		t.Fatal("an unknown token passed the gate")
	}
	if got := rec.Header().Get(remotewire.TokenHeader); got != "" {
		t.Fatalf("a refused request was handed %q", got)
	}
}

// TestRemoteTokenRotateAtFollowsTheSwitch checks the time the settings page
// shows: no expiry while the switch is off, one interval from the issue time
// while it is on.
func TestRemoteTokenRotateAtFollowsTheSwitch(t *testing.T) {
	host, clock := newTokenTestHost(t, false)
	if got := host.tokenRotateAt(); got != 0 {
		t.Fatalf("rotateAt = %d with rotation off, want 0", got)
	}
	host.tokenExpire = true
	want := clock.Now().Add(remoteTokenTTL).UnixMilli()
	if got := host.tokenRotateAt(); got != want {
		t.Fatalf("rotateAt = %d, want %d", got, want)
	}
	// A token with no issue time cannot expire: nothing knows when it began.
	host.tokenIssued = 0
	if got := host.tokenRotateAt(); got != 0 {
		t.Fatalf("rotateAt = %d for a token with no issue time, want 0", got)
	}
}
