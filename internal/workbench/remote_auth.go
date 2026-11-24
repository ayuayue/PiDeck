//go:build !js && !android && !ios

package workbench

// The phone server's token gate. A token guards every API request, and with
// rotation on it also has a lifetime: the current token, plus the one it
// replaced for a short grace window. The replacement travels in a response
// header, so a client that keeps polling this desktop takes the new token
// from a reply it was waiting for anyway and never notices the rotation.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"example.com/pideck-v2/internal/remotewire"
)

// remoteTokenHeader carries the current token to a client that presented the
// one it replaced. It is a response header rather than a route so a poll
// every few seconds keeps a connected client current for free.
const remoteTokenHeader = remotewire.TokenHeader

// remoteRequestToken is the token a request presents: its bearer header, or
// a GET's token query.
func remoteRequestToken(r *http.Request) string {
	given := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if given == "" && r.Method == http.MethodGet {
		given = r.URL.Query().Get("token")
	}
	return given
}

// remoteAuthorized compares a presented token with the one it must match, in
// constant time.
func remoteAuthorized(given, token string) bool {
	if given == "" || token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(given), []byte(token)) == 1
}

func randomToken() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}
