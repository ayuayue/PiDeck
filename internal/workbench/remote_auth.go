//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// remoteAuthorized checks the bearer token, or a GET's token query, in
// constant time.
func remoteAuthorized(r *http.Request, token string) bool {
	if token == "" {
		return false
	}
	given := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if given == "" && r.Method == http.MethodGet {
		given = r.URL.Query().Get("token")
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
