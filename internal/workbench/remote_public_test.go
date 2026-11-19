//go:build !js && !android && !ios

package workbench

import (
	"net/url"
	"testing"
)

func TestNormalizePublicURL(t *testing.T) {
	cases := map[string]string{
		"pideck.example.com":             "https://pideck.example.com",
		"https://pideck.example.com":     "https://pideck.example.com",
		"https://pideck.example.com/":    "https://pideck.example.com",
		"https://pideck.example.com/foo": "https://pideck.example.com",
		"http://192.168.1.8:8787":        "http://192.168.1.8:8787",
		"wss://pideck.example.com":       "",
		"ftp://pideck.example.com":       "",
		"":                               "",
	}
	for input, want := range cases {
		if got := normalizePublicURL(input); got != want {
			t.Errorf("normalizePublicURL(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestPublicLink(t *testing.T) {
	h := &remoteHost{publicURL: "https://pideck.example.com", token: "secret"}
	got := h.publicLink()
	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if u.Scheme != "https" || u.Host != "pideck.example.com" || u.Query().Get("token") != "secret" {
		t.Fatalf("link = %q", got)
	}
	if (&remoteHost{publicURL: "https://pideck.example.com"}).publicLink() != "" {
		t.Fatal("link without a token")
	}
	if (&remoteHost{token: "secret"}).publicLink() != "" {
		t.Fatal("link without an address")
	}
}
