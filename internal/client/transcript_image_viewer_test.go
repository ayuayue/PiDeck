package client

// The phone's picture viewer covers the window: a preview drawn in a card
// in the middle of the screen is what made the picture look half as big as
// the phone.

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// viewerPicture is the attachment the fake desktop serves.
func viewerPicture(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 240, 160))
	for y := 0; y < 160; y++ {
		for x := 0; x < 240; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 128, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestMobileImageViewerFillsTheScreen(t *testing.T) {
	const token = "viewer-token"
	pic := viewerPicture(t)
	state := remotewire.Snapshot{Name: "PiDeck", Host: "desk", Projects: []remotewire.Project{{
		Path: "/tmp/project", Name: "电脑项目",
		Sessions: []remotewire.Session{{ID: "s1", Title: "带图片的会话", Updated: time.Now().UnixMilli()}},
	}}}
	transcript := remotewire.Transcript{ID: "s1", Title: "带图片的会话", Messages: []remotewire.Message{
		{Role: "user", Text: "看看这张图"},
		{Role: "image", Text: "［图片］", Image: "ref-1"},
		{Role: "assistant", Text: "收到了，这是一张渐变图。"},
	}}
	mux := http.NewServeMux()
	check := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "PiDeck", "host": "desk"})
		}
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(state)
		}
	})
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			_ = json.NewEncoder(w).Encode(transcript)
		}
	})
	mux.HandleFunc("/api/transcript-image", func(w http.ResponseWriter, r *http.Request) {
		if check(w, r) {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pic)
		}
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	t.Setenv("PIDECK_V2_MOBILE", "1")
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("id:mobile-server", 10*time.Second)
	app.Type("id:mobile-server", server.URL)
	app.Type("id:mobile-token", token)
	app.Press("id:mobile-connect")
	waitApp(app, "text:电脑项目", 15*time.Second)
	openPhoneRail(app)
	app.WaitFor("id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "text:收到了，这是一张渐变图。", 15*time.Second)
	app.Press("id:mobile-transcript-thumbnail")
	app.WaitFor("id:transcript-image-viewer", 5*time.Second)
	app.WaitFor("id:mobile-image-full", 5*time.Second)
	app.Settle()
	viewer := app.Query("id:transcript-image-viewer")[0]
	if viewer.Frame.Size.Width < 420 || viewer.Frame.Size.Height < 860 {
		t.Fatalf("viewer frame = %v; want the whole 420x860 window", viewer.Frame)
	}
	picture := app.Query("id:mobile-image-full")[0]
	if picture.Frame.Size.Width < 300 {
		t.Fatalf("picture frame = %v; want it to fill the width", picture.Frame)
	}
	// A press on the picture closes it, and the page is back.
	app.Press("id:mobile-image-dismiss")
	app.WaitForGone("id:transcript-image-viewer", 5*time.Second)
	waitApp(app, "text:收到了，这是一张渐变图。", 5*time.Second)
}
