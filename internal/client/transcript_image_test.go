package client

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileTranscriptLoadsInlineImageAndSharesPendingRequest(t *testing.T) {
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var requests atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture" || r.URL.Query().Get("session") != "session" || r.URL.Query().Get("ref") != "image-ref" {
			t.Error("image request did not preserve authentication or reference")
		}
		if requests.Add(1) == 1 {
			close(started)
		}
		select {
		case <-release:
			w.Write(png)
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	var a *mobileApp
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newMobileApp(cx)
		a.client = &remoteClient{base: srv.URL, token: "fixture", http: srv.Client()}
		a.active.Set("session")
		return a.transcriptList()
	}, nsgotest.Size(420, 620))
	a.messages.Set([]remotewire.Message{{Role: "image", Image: "image-ref"}})
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case <-started:
			return true
		default:
			return false
		}
	})
	// Polling replaces the message slice before a slow image has arrived.
	a.messages.Set([]remotewire.Message{{Role: "image", Image: "image-ref"}})
	screen.Settle()
	close(release)
	screen.WaitFor("id:mobile-transcript-thumbnail", 5*time.Second)
	if requests.Load() != 1 {
		t.Fatalf("image requests = %d; want 1", requests.Load())
	}
	screen.Press("id:mobile-transcript-thumbnail")
	if !a.transcriptPicture.GetUntracked().Open {
		t.Fatal("thumbnail did not open the viewer")
	}
}

func TestTranscriptImageCacheIsBounded(t *testing.T) {
	var cache transcriptImageCache
	for i := range 40 {
		cache.put(transcriptImageKey{session: string(rune('a' + i))}, remotewire.Image{Data: make([]byte, 1<<20)})
	}
	if cache.bytes > 12<<20 || len(cache.items) > 24 || len(cache.items) != len(cache.order) {
		t.Fatalf("unbounded image cache: bytes=%d entries=%d order=%d", cache.bytes, len(cache.items), len(cache.order))
	}
}
