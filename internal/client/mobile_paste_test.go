package client

// Drives the phone and web composer's paste: a picture on the clipboard
// becomes a waiting attachment, anything else is left to the field, and the
// picture goes to the desktop with the message.

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// testPastedPNG is the picture the clipboard carries in these tests.
func testPastedPNG(t *testing.T) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(testPixel)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestMobileComposerPastesImages takes a picture off the clipboard.
func TestMobileComposerPastesImages(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	pixels := testPastedPNG(t)

	// A browser names the type; some clipboards do not.
	app.Paste("id:mobile-draft", core.PasteEvent{Files: []core.PastedFile{{MIME: "image/png", Data: pixels}}})
	waitApp(app, "id:mobile-pending", 5*time.Second)
	app.Paste("id:mobile-draft", core.PasteEvent{Files: []core.PastedFile{{MIME: "application/octet-stream", Data: pixels}}})
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:mobile-pending")) == 2 })

	// A file that is not a picture is not an attachment.
	app.Paste("id:mobile-draft", core.PasteEvent{Files: []core.PastedFile{{MIME: "application/pdf", Data: []byte("%PDF-1.7")}}})
	app.Settle()
	if got := len(app.Query("id:mobile-pending")); got != 2 {
		t.Fatalf("waiting pictures = %d, want 2", got)
	}
}

// TestMobileComposerPasteLimit skips a picture past the size the picker
// already enforces.
func TestMobileComposerPasteLimit(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	tooBig := make([]byte, composerImageMax+1)
	copy(tooBig, testPastedPNG(t))
	app.Paste("id:mobile-draft", core.PasteEvent{Files: []core.PastedFile{{MIME: "image/png", Data: tooBig}}})
	app.Settle()
	if got := len(app.Query("id:mobile-pending")); got != 0 {
		t.Fatalf("waiting pictures = %d, want none", got)
	}
}

// TestMobileComposerSendsPastedImage carries the picture with the message.
func TestMobileComposerSendsPastedImage(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "text:先前的回复", 15*time.Second)

	app.Paste("id:mobile-draft", core.PasteEvent{Files: []core.PastedFile{{MIME: "image/png", Data: testPastedPNG(t)}}})
	waitApp(app, "id:mobile-pending", 5*time.Second)
	app.Type("id:mobile-draft", "看这张图")
	app.Advance(200 * time.Millisecond)
	app.Press("id:mobile-send")
	waitFor(t, app, 10*time.Second, func() bool {
		sent := desk.sentPrompts()
		return len(sent) == 1 && strings.TrimSpace(sent[0]) == "看这张图" && desk.sentImages() == 1
	})
	app.WaitForGone("id:mobile-pending", 5*time.Second)
}
