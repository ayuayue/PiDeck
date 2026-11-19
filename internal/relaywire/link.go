// Package relaywire is the pairing link a phone uses to reach a desktop
// through a relay: the relay's address, the environment and its key, the
// desktop certificate's fingerprint, and the access token. It has no
// dependencies outside the standard library, so both hosts and the relay
// share it.
package relaywire

import (
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
)

const (
	// Scheme marks a relay pairing link. The phone's connect field and the
	// QR reader accept it beside http and https addresses.
	Scheme = "pideck-relay"
	// Host is the link's authority; it carries no meaning.
	Host = "tunnel"
	// Path is where a host opens its tunnel on the relay.
	Path = "/v1/tunnel"

	// RoleDesktop and RolePhone are the two ends of one tunnel.
	RoleDesktop = "desktop"
	RolePhone   = "phone"
)

var (
	// ErrNotLink says the text is an ordinary address, not a pairing link.
	ErrNotLink = errors.New("不是中继配对链接")
	// ErrBadLink says a pairing link is missing a field or has a bad address.
	ErrBadLink = errors.New("中继配对链接不完整或格式不对")
)

// Link is one desktop's relay pairing.
type Link struct {
	// Relay is the tunnel address, ws:// or wss://, ending in Path.
	Relay string
	// Env names the desktop on the relay. It is random, not a hostname.
	Env string
	// Key proves both ends belong to the same desktop.
	Key string
	// Fingerprint is the base64url SHA-256 of the desktop certificate.
	Fingerprint string
	// Token is the desktop's access token.
	Token string
}

// IsLink reports whether text is a relay pairing link.
func IsLink(text string) bool {
	return strings.HasPrefix(clean(text), Scheme+"://")
}

// clean strips what a chat app or a screenshot adds around a pasted link:
// quotes, brackets and a sentence-ending punctuation mark. A generated
// link never ends in one, so this cannot eat part of the payload.
func clean(text string) string {
	text = strings.TrimSpace(text)
	text = strings.Trim(text, "<>\"'“”‘’")
	return strings.TrimRight(text, "。，,.;；!?！？、")
}

// String encodes the link for a QR code or the clipboard.
func (l Link) String() string {
	q := url.Values{}
	q.Set("u", l.Relay)
	q.Set("e", l.Env)
	q.Set("k", l.Key)
	q.Set("f", l.Fingerprint)
	q.Set("t", l.Token)
	return Scheme + "://" + Host + "?" + q.Encode()
}

// Parse reads a pairing link. Ordinary addresses return ErrNotLink so a
// caller can fall back to a direct connection.
func Parse(text string) (Link, error) {
	text = clean(text)
	if !strings.HasPrefix(text, Scheme+"://") {
		return Link{}, ErrNotLink
	}
	u, err := url.Parse(text)
	if err != nil || u.Scheme != Scheme {
		return Link{}, ErrBadLink
	}
	q := u.Query()
	l := Link{
		Relay:       q.Get("u"),
		Env:         q.Get("e"),
		Key:         q.Get("k"),
		Fingerprint: q.Get("f"),
		Token:       q.Get("t"),
	}
	if !l.Valid() {
		return Link{}, ErrBadLink
	}
	return l, nil
}

// Valid checks every field, so a link from a QR code cannot smuggle a
// non-WebSocket address or an empty secret.
func (l Link) Valid() bool {
	if l.Env == "" || l.Key == "" || l.Fingerprint == "" || l.Token == "" {
		return false
	}
	if !opaque(l.Env) || !opaque(l.Key) || !opaque(l.Token) {
		return false
	}
	if _, err := base64.RawURLEncoding.DecodeString(l.Fingerprint); err != nil || len(l.Fingerprint) < 40 {
		return false
	}
	u, err := url.Parse(l.Relay)
	if err != nil || u.Host == "" {
		return false
	}
	return u.Scheme == "ws" || u.Scheme == "wss"
}

// DialError removes the tunnel URL from a WebSocket dial error: the URL
// carries the key, and a message shown or logged must not.
func DialError(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	const prefix = "websocket.Dial "
	if i := strings.Index(text, prefix); i >= 0 {
		rest := text[i+len(prefix):]
		if j := strings.Index(rest, ": "); j >= 0 {
			return rest[j+2:]
		}
	}
	return text
}

// URL is the tunnel address for one end, with its role and secrets.
func (l Link) URL(role string) string {
	u, err := url.Parse(l.Relay)
	if err != nil {
		return ""
	}
	q := u.Query()
	q.Set("env", l.Env)
	q.Set("key", l.Key)
	q.Set("role", role)
	u.RawQuery = q.Encode()
	return u.String()
}

// opaque keeps a field to the characters a generated secret uses, so it
// cannot break the query or a log line.
func opaque(value string) bool {
	if len(value) > 128 {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}
