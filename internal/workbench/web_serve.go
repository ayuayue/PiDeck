//go:build !js && !android && !ios

package workbench

// The browser client a desktop can carry. `go tool nsgo build -target web`
// writes the page, its loader and app.wasm; copied into webassets/site/ and built
// with -tags webassets, the same port serves the phone API and that page, so
// a browser reaches the desktop from its own origin and needs no CORS.
// Without the tag the site is absent and only the API is served.

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/andybalholm/brotli"
)

// webEncodedSuffix is how the build stores a file it compressed: the page asks
// for app.<hash>.wasm and the file beside it is app.<hash>.wasm.br.
const webEncodedSuffix = ".br"

// webAccepts says whether the request's Accept-Encoding names encoding, as
// "br" or "gzip"; q-values are ignored, which is what every browser sends.
func webAccepts(r *http.Request, encoding string) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		if strings.TrimSpace(strings.SplitN(part, ";", 2)[0]) == encoding {
			return true
		}
	}
	return false
}

// serveWebAsset answers a request for the browser client and reports whether
// it did. Its files are public: a page's own script and wasm fetch carry no
// token, while every /api path keeps the token gate.
func serveWebAsset(w http.ResponseWriter, r *http.Request) bool {
	if webAssets == nil || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	data, err := fs.ReadFile(webAssets, name)
	encoded := false
	if err != nil {
		// A web build writes the wasm brotli-compressed and drops the raw
		// file: a browser asks for app.wasm and gets the .br beside it.
		if data, err = fs.ReadFile(webAssets, name+webEncodedSuffix); err == nil {
			encoded = true
		}
	}
	if err != nil {
		// The API keeps its own answers, its 404s included.
		if strings.HasPrefix(r.URL.Path, "/api/") {
			return false
		}
		// A release names its files by content and the app has no routes of
		// its own, so an unknown path is the page.
		name = "index.html"
		if data, err = fs.ReadFile(webAssets, name); err != nil {
			return false
		}
	}
	w.Header().Set("Content-Type", webAssetType(name))
	if webAssetHashed(name) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	if !encoded {
		if r.Method == http.MethodGet {
			_, _ = w.Write(data)
		}
		return true
	}
	// The wasm is stored brotli-compressed, and a browser asks for brotli only
	// over HTTPS or on localhost: a phone, or any other machine opening the
	// plain-HTTP address, offers gzip alone. Answering 406 there leaves the
	// page with bytes it cannot compile, so the stored bytes are re-encoded for
	// whoever asks; the browser caches the answer, so this runs once per build.
	w.Header().Add("Vary", "Accept-Encoding")
	switch {
	case webAccepts(r, "br"):
		w.Header().Set("Content-Encoding", "br")
		if r.Method == http.MethodGet {
			_, _ = w.Write(data)
		}
	case webAccepts(r, "gzip"):
		w.Header().Set("Content-Encoding", "gzip")
		if r.Method == http.MethodGet {
			zw, err := gzip.NewWriterLevel(w, gzip.BestSpeed)
			if err != nil {
				return true
			}
			_, _ = io.Copy(zw, brotli.NewReader(bytes.NewReader(data)))
			_ = zw.Close()
		}
	default:
		if r.Method == http.MethodGet {
			_, _ = io.Copy(w, brotli.NewReader(bytes.NewReader(data)))
		}
	}
	return true
}

// webAssetTypes names what the site ships. A release's hashed names keep
// their extension, and the browser refuses a .wasm the server calls anything
// but application/wasm.
var webAssetTypes = map[string]string{
	".css":         "text/css; charset=utf-8",
	".html":        "text/html; charset=utf-8",
	".ico":         "image/x-icon",
	".js":          "text/javascript; charset=utf-8",
	".json":        "application/json",
	".png":         "image/png",
	".svg":         "image/svg+xml",
	".wasm":        "application/wasm",
	".webmanifest": "application/manifest+json",
	".woff2":       "font/woff2",
}

func webAssetType(name string) string {
	if t, ok := webAssetTypes[path.Ext(name)]; ok {
		return t
	}
	return "application/octet-stream"
}

// webAssetHashed says a release gave the file its content's name
// ("app.0875381b2d.wasm"), so it can be cached for good. index.html and
// nsgo.json keep their names and point at the rest.
func webAssetHashed(name string) bool {
	base := strings.TrimSuffix(path.Base(name), path.Ext(name))
	dot := strings.LastIndex(base, ".")
	if dot < 0 {
		return false
	}
	hash := base[dot+1:]
	if len(hash) < 8 {
		return false
	}
	for _, c := range hash {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
