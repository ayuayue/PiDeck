//go:build !js && !android && !ios

package workbench

// A public address the user points at this desktop themselves: a Cloudflare
// Tunnel, a reverse proxy or a domain that forwards to the remote port.
// PiDeck cannot discover it, so the user enters it and gets the usual link
// and QR code.

import (
	"net/url"
	"strings"
)

// normalizePublicURL accepts an address a user pastes and returns the
// origin the phone should use. A path is dropped: the API lives at the
// root of whatever forwards to this desktop.
func normalizePublicURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// setPublicURL stores the address and refreshes the link.
func (h *remoteHost) setPublicURL(raw string) {
	value := normalizePublicURL(raw)
	h.app.cfg.RemotePublicURL = value
	h.app.st.edit(func(c *config) { c.RemotePublicURL = value })
	h.mu.Lock()
	h.publicURL = value
	h.mu.Unlock()
	h.publish()
}

// publicLink is the address with the token, or "" until both exist.
func (h *remoteHost) publicLink() string {
	h.mu.Lock()
	base, token := h.publicURL, h.token
	h.mu.Unlock()
	if base == "" || token == "" {
		return ""
	}
	return base + "/?token=" + url.QueryEscape(token)
}
