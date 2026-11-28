//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"example.com/pideck/internal/relaywire"
)

// TestRelayCertificateStable checks that the pinned fingerprint survives a
// restart and that the key file stays private.
func TestRelayCertificateStable(t *testing.T) {
	dir := t.TempDir()
	first, err := relayCertificate(dir)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	fp := relayFingerprint(first)
	if len(fp) != 43 {
		t.Fatalf("fingerprint = %q", fp)
	}
	second, err := relayCertificate(dir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if relayFingerprint(second) != fp {
		t.Fatal("fingerprint changed across a reload")
	}
	info, err := os.Stat(filepath.Join(dir, relayCertFile))
	if err != nil {
		t.Fatal(err)
	}
	// Windows has no Unix permission bits to check.
	if runtime.GOOS != "windows" {
		if mode := info.Mode().Perm(); mode&0o077 != 0 {
			t.Fatalf("certificate file mode = %o", mode)
		}
	}
}

func TestNormalizeRelayURL(t *testing.T) {
	cases := map[string]string{
		"relay.example.com":                 "wss://relay.example.com/v1/tunnel",
		"wss://relay.example.com":           "wss://relay.example.com/v1/tunnel",
		"wss://relay.example.com/v1/tunnel": "wss://relay.example.com/v1/tunnel",
		"https://relay.example.com":         "wss://relay.example.com/v1/tunnel",
		"http://relay.example.com":          "ws://relay.example.com/v1/tunnel",
		"":                                  "",
		"not a url":                         "",
	}
	for input, want := range cases {
		if got := normalizeRelayURL(input); got != want {
			t.Errorf("normalizeRelayURL(%q) = %q, want %q", input, got, want)
		}
	}
}

// TestRelayLink checks the pairing link carries the token and the pinned
// certificate, and that it parses back.
func TestRelayLink(t *testing.T) {
	cert, err := relayCertificate(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := &remoteHost{
		relayURL:  "wss://relay.example.com/v1/tunnel",
		relayEnv:  strings.Repeat("a", 48),
		relayKey:  strings.Repeat("b", 48),
		relayCert: cert,
		token:     "secret",
	}
	text := h.relayLink()
	link, err := relaywire.Parse(text)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if link.Token != "secret" || link.Relay != h.relayURL || link.Env != h.relayEnv {
		t.Fatalf("link = %+v", link)
	}
	if link.Fingerprint != relayFingerprint(cert) {
		t.Fatalf("fingerprint = %q", link.Fingerprint)
	}

	empty := &remoteHost{}
	if got := empty.relayLink(); got != "" {
		t.Fatalf("empty link = %q", got)
	}
}
