//go:build !js && !android && !ios

package workbench

// Checks the names the browser client is served under. What a -tags
// webassets build actually carries is tested in web_assets_test.go.

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/andybalholm/brotli"
)

// wasmMagic stands in for the app's bytes: the four bytes every module
// starts with, so a decompressed body is recognizable.
const wasmMagic = "\x00asm\x01\x00\x00\x00"

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

// TestWebAssetEncoded checks the compressed wasm: the page asks for
// app.<hash>.wasm, the file on hand is the .br beside it. A browser offers
// brotli only over HTTPS or on localhost, so a phone opening the LAN address
// offers gzip alone and must still get bytes it can compile.
func TestWebAssetEncoded(t *testing.T) {
	var stored bytes.Buffer
	zw := brotli.NewWriter(&stored)
	if _, err := zw.Write([]byte(wasmMagic)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	old := webAssets
	webAssets = fstest.MapFS{"app.0875381b2d.wasm.br": {Data: stored.Bytes()}}
	defer func() { webAssets = old }()

	br := httptest.NewRequest(http.MethodGet, "/app.0875381b2d.wasm", nil)
	br.Header.Set("Accept-Encoding", "gzip, deflate, br")
	rec := httptest.NewRecorder()
	if !serveWebAsset(rec, br) {
		t.Fatal("the compressed wasm was not served")
	}
	for header, want := range map[string]string{
		"Content-Encoding": "br",
		"Content-Type":     "application/wasm",
		"Cache-Control":    "public, max-age=31536000, immutable",
		"Vary":             "Accept-Encoding",
	} {
		if got := rec.Header().Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	if body, err := io.ReadAll(brotli.NewReader(rec.Body)); err != nil || string(body) != wasmMagic {
		t.Errorf("br body = %q, err %v", body, err)
	}

	// A phone's plain-HTTP request offers gzip alone; it gets gzip of the
	// same wasm, not a 406 that fails the page with "HTTP status code is not
	// ok".
	plain := httptest.NewRequest(http.MethodGet, "/app.0875381b2d.wasm", nil)
	plain.Header.Set("Accept-Encoding", "gzip, deflate")
	rec = httptest.NewRecorder()
	if !serveWebAsset(rec, plain) {
		t.Fatal("a gzip client was refused")
	}
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("gzip client got %d %q, want 200 gzip", rec.Code, rec.Header().Get("Content-Encoding"))
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip body: %v", err)
	}
	if body, err := io.ReadAll(zr); err != nil || string(body) != wasmMagic {
		t.Fatalf("gzip body = %q, err %v", body, err)
	}

	// Neither encoding accepted: the wasm still arrives, uncompressed.
	none := httptest.NewRequest(http.MethodGet, "/app.0875381b2d.wasm", nil)
	rec = httptest.NewRecorder()
	if !serveWebAsset(rec, none) {
		t.Fatal("a client offering no encoding was refused")
	}
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("plain client got %d %q, want 200 identity", rec.Code, rec.Header().Get("Content-Encoding"))
	}
	if body := rec.Body.String(); body != wasmMagic {
		t.Errorf("identity body = %q", body)
	}

	if !webAccepts(br, "br") || webAccepts(plain, "br") || !webAccepts(plain, "gzip") {
		t.Fatal("encoding negotiation is misread")
	}
	if webAccepts(httptest.NewRequest(http.MethodGet, "/", nil), "br") {
		t.Fatal("a request without Accept-Encoding was read as brotli")
	}
}
