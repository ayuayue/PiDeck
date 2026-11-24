//go:build !js && !android && !ios

package workbench

// The phone server's access token and how long it lives. A token copied off
// a screen is a link anybody who has seen it can use, so an owner can have
// it rotate: a new token is issued on an interval, and the one it replaced
// is accepted for one more interval, so a connected client has time to
// take the new one from a response. Off by default, because a phone that is
// never re-paired must keep working.

import (
	"net/http"
	"time"
)

const (
	// remoteTokenTTL is how often a new token is issued while rotation is
	// on, and how long one lives: the replaced token lives out one more
	// interval, so a client left idle for up to an interval still finds its
	// token good and never has to be paired again.
	remoteTokenTTL   = 24 * time.Hour
	remoteTokenGrace = remoteTokenTTL
)

// rotateAtLocked is when the token on screen is replaced, 0 while rotation
// is off. The caller holds h.mu.
func (h *remoteHost) rotateAtLocked() int64 {
	if !h.tokenExpire || h.token == "" || h.tokenIssued == 0 {
		return 0
	}
	return h.tokenIssued + remoteTokenTTL.Milliseconds()
}

// tokenRotateAt is when the token expires, 0 for a token that does not.
func (h *remoteHost) tokenRotateAt() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.rotateAtLocked()
}

// now is the host's clock: the app's, so a test can move a token's lifetime,
// or the system's when the host was built without one.
func (h *remoteHost) now() time.Time {
	if h.clock != nil {
		return h.clock()
	}
	return time.Now()
}

// setTokenExpire turns rotation on or off and stores the choice.
func (h *remoteHost) setTokenExpire(on bool) {
	h.app.cfg.RemoteTokenExpire = on
	h.app.st.edit(func(c *config) { c.RemoteTokenExpire = on })
	h.mu.Lock()
	h.tokenExpire = on
	h.mu.Unlock()
	if on {
		// A token made before the switch existed has no start time, so
		// nothing knows when its interval began: a fresh one begins it.
		if h.currentToken() == "" || h.issuedAt() == 0 {
			h.issueToken()
		}
		h.armTokenRotation()
	} else {
		// Nothing expires, so the timer and the token it would replace go.
		h.stopTokenRotation()
		h.mu.Lock()
		h.prevToken, h.prevReplaced = "", 0
		h.mu.Unlock()
	}
	h.publish()
}

// issuedAt is when the current token was made, unix milliseconds.
func (h *remoteHost) issuedAt() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.tokenIssued
}

// armTokenRotation stops the pending rotation and starts the one the switch
// asks for.
func (h *remoteHost) armTokenRotation() {
	h.stopTokenRotation()
	next := h.tokenRotateAt()
	if next == 0 {
		return
	}
	// An interval that ran out while the app slept rotates on the next
	// look rather than after a negative wait.
	wait := time.Duration(next-h.now().UnixMilli()) * time.Millisecond
	if wait < 0 {
		wait = 0
	}
	h.mu.Lock()
	h.tokenStop = h.app.cx.AfterFunc(wait, func() {
		h.mu.Lock()
		h.tokenStop = nil
		h.mu.Unlock()
		h.issueToken()
	})
	h.mu.Unlock()
}

// stopTokenRotation ends the pending rotation, if any.
func (h *remoteHost) stopTokenRotation() {
	h.mu.Lock()
	stop := h.tokenStop
	h.tokenStop = nil
	h.mu.Unlock()
	if stop != nil {
		stop()
	}
}

// remoteTokenAccepted says whether a presented token still works: the
// current one always does, and the one it replaced for the grace window
// after the rotation. A token older than that is dead, which is the point
// of the switch.
func (h *remoteHost) remoteTokenAccepted(given string) bool {
	if given == "" {
		return false
	}
	h.mu.Lock()
	token, expire, prev, replaced := h.token, h.tokenExpire, h.prevToken, h.prevReplaced
	h.mu.Unlock()
	if remoteAuthorized(given, token) {
		return true
	}
	if !expire || prev == "" || replaced == 0 {
		return false
	}
	if h.now().UnixMilli() >= replaced+remoteTokenGrace.Milliseconds() {
		return false
	}
	return remoteAuthorized(given, prev)
}

// authorize is the token gate, and what a client hears back: one that
// presented the replaced token already gets the current one in a header, so
// a poll refreshes it without any extra request.
func (h *remoteHost) authorize(w http.ResponseWriter, r *http.Request) bool {
	given := remoteRequestToken(r)
	if !h.remoteTokenAccepted(given) {
		return false
	}
	if current := h.currentToken(); !remoteAuthorized(given, current) {
		w.Header().Set(remoteTokenHeader, current)
	}
	return true
}
