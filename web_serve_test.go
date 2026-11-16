package main

// Checks the names the browser client is served under. What a -tags
// webassets build actually carries is tested in web_assets_test.go.

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestWebAssetNames checks the type and cache rules a release's file names
// follow.
func TestWebAssetNames(t *testing.T) {
	for name, want := range map[string]string{
		"index.html":                  "text/html; charset=utf-8",
		"app.0875381b2d.wasm":         "application/wasm",
		"nsgo.f0b2469c31.js":          "text/javascript; charset=utf-8",
		"manifest.webmanifest":        "application/manifest+json",
		"page.0c115416ee.css":         "text/css; charset=utf-8",
		"icon-192.fe9ecb3371.png":     "image/png",
		"unknown.0c115416ee.xyz":      "application/octet-stream",
		"nested/index.html":           "text/html; charset=utf-8",
		"apple-touch-icon.28c852.png": "image/png",
	} {
		if got := webAssetType(name); got != want {
			t.Errorf("webAssetType(%q) = %q, want %q", name, got, want)
		}
	}
	if webAssetHashed("index.html") || webAssetHashed("nsgo.json") {
		t.Fatal("a name without a hash was called cacheable")
	}
	if !webAssetHashed("app.0875381b2d.wasm") {
		t.Fatal("a hashed name was not cacheable")
	}
	if webAssetHashed("nsgo.f0b2.js") {
		t.Fatal("a short hash was accepted")
	}
}

// TestNoWebClientWithoutTag checks a default build serves the API alone.
func TestNoWebClientWithoutTag(t *testing.T) {
	if webAssets != nil {
		t.Skip("built with -tags webassets")
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if serveWebAsset(rec, req) {
		t.Fatal("a build without the site served one")
	}
	h := &remoteHost{}
	rec = httptest.NewRecorder()
	h.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET / = %d, want 401 without a token", rec.Code)
	}
}

// TestWebClientPaths checks the paths a page asks for, against whatever the
// build carries.
func TestWebClientPaths(t *testing.T) {
	if webAssets == nil {
		t.Skip("built without -tags webassets")
	}
	for _, c := range []struct {
		path, wantType string
	}{
		{"/", "text/html; charset=utf-8"},
		{"/index.html", "text/html; charset=utf-8"},
		{"/nsgo.json", "application/json"},
		{"/some/client/route", "text/html; charset=utf-8"},
	} {
		rec := httptest.NewRecorder()
		if !serveWebAsset(rec, httptest.NewRequest(http.MethodGet, c.path, nil)) {
			t.Fatalf("GET %s served nothing", c.path)
		}
		if got := rec.Header().Get("Content-Type"); got != c.wantType {
			t.Errorf("GET %s type = %q, want %q", c.path, got, c.wantType)
		}
	}
	// The API keeps its token gate beside the page.
	h := &remoteHost{}
	rec := httptest.NewRecorder()
	h.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/state = %d, want 401 without a token", rec.Code)
	}
}
